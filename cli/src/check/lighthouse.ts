// Lighthouse performance and accessibility: median of N runs (default 5) per route, under the
// machine-wide perf lock. >= 90 passes, 85 to 89 warns, under 85 fails.
import type { Gate, GateStatus } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { acquireLock, perfLockPath } from "./lock.ts";

export const LH_PASS = 90;
export const LH_WARN = 85;
export const LH_CATEGORIES = ["performance", "accessibility"] as const;
type Category = (typeof LH_CATEGORIES)[number];

export interface LhRun {
  performance: number | null;
  accessibility: number | null;
  error?: string;
}
export type LhRunner = (url: string) => Promise<LhRun>;

export function classifyScore(score: number): GateStatus {
  return score >= LH_PASS ? "pass" : score >= LH_WARN ? "warn" : "fail";
}

export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const RANK: Record<GateStatus, number> = { pass: 0, skip: 0, warn: 1, fail: 2 };
const worst = (a: GateStatus, b: GateStatus): GateStatus => (RANK[b] > RANK[a] ? b : a);

/** Launch the pinned Chromium (Playwright's) through chrome-launcher and return a runner. */
export async function defaultRunner(): Promise<{ run: LhRunner; close: () => Promise<void> }> {
  const [{ default: lighthouse }, chromeLauncher, { chromium }] = await Promise.all([
    import("lighthouse"),
    import("chrome-launcher"),
    import("playwright"),
  ]);
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions"],
  });
  const run: LhRunner = async (url) => {
    try {
      const r = await lighthouse(url, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: [...LH_CATEGORIES] });
      const lhr = r?.lhr;
      if (!lhr) return { performance: null, accessibility: null, error: "lighthouse returned no result" };
      const pick = (c: Category) => (typeof lhr.categories[c]?.score === "number" ? Math.round((lhr.categories[c].score as number) * 100) : null);
      return { performance: pick("performance"), accessibility: pick("accessibility"), error: lhr.runtimeError ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` : undefined };
    } catch (e) {
      return { performance: null, accessibility: null, error: (e as Error).message };
    }
  };
  return { run, close: async () => void (await chrome.kill()) };
}

export interface LighthouseOptions {
  runs?: number;
  runner?: LhRunner;
  lockPath?: string;
  lockTimeoutMs?: number;
}

export async function lighthouseGate(base: string | null, routes: readonly string[], opts: LighthouseOptions = {}, why = "no site to check"): Promise<Gate> {
  const id = "lighthouse";
  if (!base) return gate(id, "fail", `cannot run: ${why}`);
  const runs = opts.runs ?? 5;
  let lock;
  try {
    lock = await acquireLock(opts.lockPath ?? perfLockPath(), opts.lockTimeoutMs);
  } catch (e) {
    return gate(id, "fail", `cannot run: ${(e as Error).message}`);
  }
  let owned: { run: LhRunner; close: () => Promise<void> } | null = null;
  try {
    let runner = opts.runner;
    if (!runner) {
      try {
        owned = await defaultRunner();
      } catch (e) {
        return gate(id, "fail", `cannot run: Chrome for Lighthouse did not start: ${(e as Error).message}`);
      }
      runner = owned.run;
    }
    let status: GateStatus = "pass";
    const perRoute: Record<string, unknown>[] = [];
    const metrics: Record<string, number | string | boolean | null> = { runs, lock_wait_s: Math.round(lock.waitedMs / 1000) };
    let minPerf = 100;
    let minA11y = 100;
    for (const route of routes) {
      const url = new URL(route.replace(/^\//, ""), base).toString();
      const results: LhRun[] = [];
      for (let i = 0; i < runs; i++) results.push(await runner(url));
      const errors = results.filter((r) => r.error || r.performance === null || r.accessibility === null);
      if (errors.length) {
        status = "fail";
        perRoute.push({ route, status: "fail", error: errors[0].error ?? "a category had no score", failed_runs: errors.length });
        continue;
      }
      const perf = medianOf(results.map((r) => r.performance as number));
      const a11y = medianOf(results.map((r) => r.accessibility as number));
      minPerf = Math.min(minPerf, perf);
      minA11y = Math.min(minA11y, a11y);
      const st = worst(classifyScore(perf), classifyScore(a11y));
      status = worst(status, st);
      perRoute.push({ route, status: st, performance: perf, accessibility: a11y, performance_runs: results.map((r) => r.performance), accessibility_runs: results.map((r) => r.accessibility) });
    }
    metrics.min_performance = minPerf;
    metrics.min_accessibility = minA11y;
    const below = perRoute.filter((r) => r.status !== "pass").map((r) => r.route);
    const summary =
      status === "pass"
        ? `median of ${runs} runs: performance and accessibility >= ${LH_PASS} on all ${routes.length} routes (lowest ${minPerf} / ${minA11y})`
        : `median of ${runs} runs below ${LH_PASS} (${status === "warn" ? `warn ${LH_WARN}-${LH_PASS - 1}` : `fail under ${LH_WARN} or error`}) on ${below.join(", ")}`;
    return gate(id, status, summary, metrics, { routes: perRoute, config: "lighthouse default (mobile, simulated throttling)" });
  } finally {
    if (owned) await owned.close().catch(() => undefined);
    lock.release();
  }
}
