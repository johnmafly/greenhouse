// Lighthouse on the mobile config (default form factor, simulated throttling): median of N runs
// (default 5) per route, under the machine-wide perf lock.
// Contract v2: performance >= 90, CLS <= 0.1 and TBT <= 200 ms, else fail.
// Accessibility: >= 90 passes, 85 to 89 warns, under 85 fails.
import type { Gate, GateStatus } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { acquireLock, perfLockPath } from "./lock.ts";

export const LH_PASS = 90;
export const LH_WARN = 85;
export const LH_MAX_CLS = 0.1;
export const LH_MAX_TBT_MS = 200;
export const LH_CATEGORIES = ["performance", "accessibility"] as const;
type Category = (typeof LH_CATEGORIES)[number];

export interface LhRun {
  performance: number | null;
  accessibility: number | null;
  /** Cumulative Layout Shift (unitless). */
  cls?: number | null;
  /** Total Blocking Time in ms. */
  tbt?: number | null;
  /** lhr.configSettings.formFactor; must be "mobile". */
  formFactor?: string;
  error?: string;
}
export type LhRunner = (url: string) => Promise<LhRun>;

export function classifyScore(score: number): GateStatus {
  return score >= LH_PASS ? "pass" : score >= LH_WARN ? "warn" : "fail";
}

/** Contract v2 for one route's medians: performance >= 90, CLS <= 0.1, TBT <= 200 ms (else fail). */
export function classifyRoute(m: { performance: number; accessibility: number; cls: number; tbt: number }): { status: GateStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (m.performance < LH_PASS) reasons.push(`performance ${m.performance} < ${LH_PASS}`);
  if (m.cls > LH_MAX_CLS) reasons.push(`CLS ${m.cls} > ${LH_MAX_CLS}`);
  if (m.tbt > LH_MAX_TBT_MS) reasons.push(`TBT ${m.tbt} ms > ${LH_MAX_TBT_MS} ms`);
  const a11y = classifyScore(m.accessibility);
  if (a11y !== "pass") reasons.push(`accessibility ${m.accessibility} < ${LH_PASS}`);
  return { status: reasons.length > (a11y === "warn" ? 1 : 0) ? "fail" : a11y, reasons };
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
      const num = (audit: string) => (typeof lhr.audits[audit]?.numericValue === "number" ? (lhr.audits[audit].numericValue as number) : null);
      return {
        performance: pick("performance"),
        accessibility: pick("accessibility"),
        cls: num("cumulative-layout-shift"),
        tbt: num("total-blocking-time"),
        formFactor: lhr.configSettings?.formFactor,
        error: lhr.runtimeError ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` : undefined,
      };
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
    let maxCls = 0;
    let maxTbt = 0;
    for (const route of routes) {
      const url = new URL(route.replace(/^\//, ""), base).toString();
      const results: LhRun[] = [];
      for (let i = 0; i < runs; i++) results.push(await runner(url));
      const errors = results.filter((r) => r.error || r.performance === null || r.accessibility === null || r.cls == null || r.tbt == null);
      if (errors.length) {
        status = "fail";
        perRoute.push({ route, status: "fail", error: errors[0].error ?? "a category or metric (CLS, TBT) had no value", failed_runs: errors.length });
        continue;
      }
      const notMobile = results.find((r) => r.formFactor !== undefined && r.formFactor !== "mobile");
      if (notMobile) {
        status = "fail";
        perRoute.push({ route, status: "fail", error: `form factor ${notMobile.formFactor}, not mobile` });
        continue;
      }
      const perf = medianOf(results.map((r) => r.performance as number));
      const a11y = medianOf(results.map((r) => r.accessibility as number));
      const cls = Math.round(medianOf(results.map((r) => r.cls as number)) * 1000) / 1000;
      const tbt = Math.round(medianOf(results.map((r) => r.tbt as number)));
      minPerf = Math.min(minPerf, perf);
      minA11y = Math.min(minA11y, a11y);
      maxCls = Math.max(maxCls, cls);
      maxTbt = Math.max(maxTbt, tbt);
      const c = classifyRoute({ performance: perf, accessibility: a11y, cls, tbt });
      status = worst(status, c.status);
      perRoute.push({
        route,
        status: c.status,
        ...(c.reasons.length ? { reasons: c.reasons } : {}),
        performance: perf,
        accessibility: a11y,
        cls,
        tbt_ms: tbt,
        performance_runs: results.map((r) => r.performance),
        accessibility_runs: results.map((r) => r.accessibility),
        cls_runs: results.map((r) => r.cls as number),
        tbt_runs: results.map((r) => Math.round(r.tbt as number)),
      });
    }
    metrics.min_performance = minPerf;
    metrics.min_accessibility = minA11y;
    metrics.max_cls = maxCls;
    metrics.max_tbt_ms = maxTbt;
    const below = perRoute.filter((r) => r.status !== "pass").map((r) => `${r.route}${r.reasons ? ` (${(r.reasons as string[]).join(", ")})` : r.error ? ` (${r.error})` : ""}`);
    const summary =
      status === "pass"
        ? `mobile, median of ${runs} runs on all ${routes.length} routes: performance >= ${LH_PASS}, accessibility >= ${LH_PASS}, CLS <= ${LH_MAX_CLS}, TBT <= ${LH_MAX_TBT_MS} ms (lowest ${minPerf} / ${minA11y}, worst CLS ${maxCls}, TBT ${maxTbt} ms)`
        : `mobile, median of ${runs} runs: ${status} on ${below.join("; ")}`;
    return gate(id, status, summary, metrics, { routes: perRoute, config: "lighthouse default (mobile form factor, simulated throttling)", thresholds: { performance: LH_PASS, accessibility_warn: LH_WARN, cls: LH_MAX_CLS, tbt_ms: LH_MAX_TBT_MS } });
  } finally {
    if (owned) await owned.close().catch(() => undefined);
    lock.release();
  }
}
