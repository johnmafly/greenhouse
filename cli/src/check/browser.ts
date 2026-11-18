// Browser gates on the pinned Playwright Chromium: axe-core accessibility and the signup flow.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser } from "playwright";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";

const require = createRequire(import.meta.url);

/** Whether the pinned Chromium is installed (and not disabled with GREENHOUSE_SKIP_BROWSER=1). */
export async function browserAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (process.env.GREENHOUSE_SKIP_BROWSER === "1") return { ok: false, reason: "GREENHOUSE_SKIP_BROWSER=1" };
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    return existsSync(path) ? { ok: true } : { ok: false, reason: `Chromium not installed at ${path} (run: npx playwright install chromium)` };
  } catch (e) {
    return { ok: false, reason: `playwright not loadable: ${(e as Error).message}` };
  }
}

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

let axeSource: string | null = null;
function axe(): string {
  axeSource ??= readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
}

/** axe-core on each page: any critical violation fails, serious ones warn. */
export async function axeGate(browser: Browser | null, base: string | null, paths: string[], why = "no site to check"): Promise<Gate> {
  const id = "axe";
  if (!base) return gate(id, "fail", `cannot run: ${why}`);
  if (!browser) return gate(id, "fail", `cannot run: ${why}`);
  if (paths.length === 0) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const context = await browser.newContext();
  const results: { page: string; violations: AxeViolation[] }[] = [];
  try {
    for (const path of paths) {
      const page = await context.newPage();
      try {
        await page.goto(new URL(path.replace(/^\//, ""), base).toString(), { waitUntil: "load", timeout: 30_000 });
        await page.addScriptTag({ content: axe() });
        const v: AxeViolation[] = await page.evaluate(async () => {
          const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
          return r.violations.map((x: any) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.length, targets: x.nodes.slice(0, 5).map((n: any) => String(n.target)) }));
        });
        results.push({ page: path, violations: v });
      } catch (e) {
        await context.close();
        return gate(id, "fail", `cannot run axe on ${path}: ${(e as Error).message.split("\n")[0]}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  const count = (impact: string) => results.reduce((n, r) => n + r.violations.filter((v) => v.impact === impact).length, 0);
  const critical = count("critical");
  const serious = count("serious");
  const metrics = { pages: paths.length, critical, serious, moderate: count("moderate"), minor: count("minor") };
  const details = { violations: results.filter((r) => r.violations.length) };
  if (critical) return gate(id, "fail", `${critical} critical axe violation${critical === 1 ? "" : "s"}`, metrics, details);
  if (serious) return gate(id, "warn", `no critical axe violations; ${serious} serious`, metrics, details);
  return gate(id, "pass", `no critical or serious axe violations on ${paths.length} pages`, metrics, results.some((r) => r.violations.length) ? details : undefined);
}

/** Cloudflare Web Analytics posts its beacon to the site's own /cdn-cgi/rum; the edge injects it. */
export function isCloudflareRum(method: string, url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return method === "POST" && u.origin === origin && (u.pathname === "/cdn-cgi/rum" || u.pathname.startsWith("/cdn-cgi/rum/"));
  } catch {
    return false;
  }
}

/**
 * Signup flow (contract): start at content.signup (v1: /signup/), fill the visible fields, press the step's
 * `[data-signup-next]` (or `[data-next]`) control (or the visible form's submit button) until a visible
 * `[data-signup-final]` screen appears that says it is a preview. Nothing may be stored
 * (cookies, localStorage, sessionStorage) and nothing may be sent (no non-GET requests, except
 * Cloudflare Web Analytics' same-origin `POST /cdn-cgi/rum` beacon, which is listed as ignored).
 */
export async function signupGate(browser: Browser | null, base: string | null, why = "no site to check", maxSteps = 12, start = "/signup/"): Promise<Gate> {
  const id = "signup-flow";
  if (!base || !browser) return gate(id, "fail", `cannot run: ${why}`);
  const origin = new URL(base).origin;
  const context = await browser.newContext();
  const page = await context.newPage();
  const sent: string[] = [];
  const ignored: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (r) => {
    if (["GET", "HEAD"].includes(r.method())) return;
    if (isCloudflareRum(r.method(), r.url(), origin)) ignored.push(`${r.method()} ${r.url()}`);
    else sent.push(`${r.method()} ${r.url()}`);
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const steps: string[] = [];
  const fail = async (summary: string) => {
    await context.close().catch(() => undefined);
    return gate(id, "fail", summary, { steps: steps.length }, { start, steps, sent, ignored, page_errors: pageErrors });
  };
  try {
    await page.goto(new URL(start.replace(/^\//, ""), base).toString(), { waitUntil: "load", timeout: 30_000 });
    for (let step = 0; step <= maxSteps; step++) {
      if (new URL(page.url()).origin !== origin) return await fail(`signup left the site for ${new URL(page.url()).origin}`);
      const final = page.locator("[data-signup-final]:visible").first();
      if ((await final.count()) > 0) {
        const text = (await final.innerText()).replace(/\s+/g, " ");
        if (!/preview/i.test(text)) return await fail("the final signup screen does not say it is a preview");
        const cookies = await context.cookies();
        const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
        const stored: string[] = [];
        if (cookies.length) stored.push(`${cookies.length} cookie(s)`);
        if (storage.local) stored.push(`${storage.local} localStorage item(s)`);
        if (storage.session) stored.push(`${storage.session} sessionStorage item(s)`);
        if (stored.length) return await fail(`signup stores data: ${stored.join(", ")}`);
        if (sent.length) return await fail(`signup sends data: ${sent[0]}${sent.length > 1 ? ` (+${sent.length - 1})` : ""}`);
        await context.close();
        const note = ignored.length ? ` (ignored ${ignored.length} Cloudflare Web Analytics beacon${ignored.length === 1 ? "" : "s"})` : "";
        return gate(id, "pass", `reached the final preview screen in ${steps.length} step${steps.length === 1 ? "" : "s"} from ${start}; nothing stored or sent${note}`, { steps: steps.length }, ignored.length ? { start, steps, ignored } : { start, steps });
      }
      if (step === maxSteps) return await fail(`no final screen ([data-signup-final]) after ${maxSteps} steps`);
      // Fill every visible, enabled, empty field.
      const fields = page.locator("input:visible:enabled, select:visible:enabled, textarea:visible:enabled");
      const n = await fields.count();
      const radios = new Set<string>();
      for (let i = 0; i < n; i++) {
        const f = fields.nth(i);
        const tag = await f.evaluate((el) => el.tagName.toLowerCase());
        const type = ((await f.getAttribute("type")) ?? "text").toLowerCase();
        if (tag === "select") {
          const values = await f.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
          if (values.length) await f.selectOption(values[0]);
        } else if (type === "checkbox") {
          if (!(await f.isChecked())) await f.check();
        } else if (type === "radio") {
          const name = (await f.getAttribute("name")) ?? `#${i}`;
          if (!radios.has(name)) {
            radios.add(name);
            await f.check();
          }
        } else if (!["submit", "button", "reset", "hidden", "image", "file", "range", "color"].includes(type)) {
          if (!(await f.inputValue())) {
            const value = type === "email" ? "preview@example.com" : type === "url" ? "https://example.com" : type === "tel" ? "+15555550100" : type === "number" ? "1" : type === "password" ? "Preview-pass-123" : type === "date" ? "2026-01-01" : "Preview";
            await f.fill(value);
          }
        }
      }
      let next = page.locator("[data-signup-next]:visible, [data-next]:visible").first();
      if ((await next.count()) === 0) next = page.locator("form:visible :is(button[type=submit], button:not([type]), input[type=submit]):visible").first();
      if ((await next.count()) === 0)
        return await fail(
          steps.length === 0
            ? "no way forward on step 1 (no visible [data-signup-next], [data-next] or form submit button) and no [data-signup-final] screen"
            : `stopped after ${steps.length} step${steps.length === 1 ? "" : "s"}: no visible way forward and no [data-signup-final] screen (mark the last screen with data-signup-final)`,
        );
      const label = ((await next.innerText().catch(() => "")) || (await next.getAttribute("value")) || "next").trim().slice(0, 60);
      steps.push(label);
      const before = page.url();
      await next.click({ timeout: 10_000 });
      await page.waitForLoadState("load");
      if (page.url() === before) await page.waitForTimeout(150);
    }
    return await fail("signup flow did not finish");
  } catch (e) {
    return await fail(`signup flow error: ${(e as Error).message.split("\n")[0]}`);
  }
}
