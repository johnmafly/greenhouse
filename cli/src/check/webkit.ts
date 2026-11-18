// webkit-iphone: every start route in Playwright WebKit with the iPhone 15 Pro profile, the engine
// iPhones actually run. Chromium-only gates cannot see Safari failures (BotRampart v2 on an iPhone).
//
// Fails on a page error, a same-origin request that fails or returns 4xx/5xx, a same-origin
// stylesheet with no CSS rules, a non-local @font-face that does not load, a CSP violation that
// blocks the site's own same-origin resource, and a computed-style mismatch with Chromium (primary
// h1 font family, body background colour). Host-injected third-party scripts (Cloudflare's
// static.cloudflareinsights.com beacon, /cdn-cgi/) are ignored, like the /cdn-cgi/rum rule in
// signup-flow. A fold screenshot per route goes to the evidence directory.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";

export const IPHONE = "iPhone 15 Pro";

/** Whether the pinned WebKit is installed (and not disabled with GREENHOUSE_SKIP_BROWSER=1). */
export async function webkitAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (process.env.GREENHOUSE_SKIP_BROWSER === "1") return { ok: false, reason: "GREENHOUSE_SKIP_BROWSER=1" };
  try {
    const { webkit } = await import("playwright");
    const path = webkit.executablePath();
    return existsSync(path) ? { ok: true } : { ok: false, reason: `WebKit not installed at ${path} (run: npx playwright install webkit)` };
  } catch (e) {
    return { ok: false, reason: `playwright not loadable: ${(e as Error).message}` };
  }
}

export async function launchWebkit(): Promise<Browser> {
  const { webkit } = await import("playwright");
  return webkit.launch({ headless: true });
}

export async function iphoneProfile(): Promise<BrowserContextOptions> {
  const { devices } = await import("playwright");
  const { defaultBrowserType: _ignored, ...profile } = devices[IPHONE];
  return profile;
}

/** File name for a route's screenshot: "/" -> home, "/docs/how-it-works/" -> docs-how-it-works. */
export function routeFile(path: string): string {
  const p = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-");
  return p || "home";
}

/** Host-injected scripts and endpoints the site does not control. */
export function isHostInjected(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "static.cloudflareinsights.com" || (u.origin === origin && u.pathname.startsWith("/cdn-cgi/"));
  } catch {
    return false;
  }
}

export interface PageProbe {
  emptyStylesheets: string[];
  fonts: { family: string; status: string }[];
  h1Font: string | null;
  bodyBackground: number[] | null;
}

/** Runs in the page: stylesheet rule counts, non-local font loads, h1 primary font, body background (as RGBA). */
async function probe(page: Page): Promise<PageProbe> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page.evaluate(async () => {
    const emptyStylesheets: string[] = [];
    const families = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSFontFaceRule) {
          const src = r.style.getPropertyValue("src");
          if (/url\(/i.test(src)) families.add(r.style.getPropertyValue("font-family").replace(/^["']|["']$/g, "").trim().toLowerCase());
        } else if ("cssRules" in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      if (!sheet.href || new URL(sheet.href).origin !== location.origin) {
        if (!sheet.href) {
          try {
            walk(sheet.cssRules);
          } catch {
            /* inaccessible */
          }
        }
        continue;
      }
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        rules = null;
      }
      if (!rules || rules.length === 0) emptyStylesheets.push(new URL(sheet.href).pathname + new URL(sheet.href).search);
      else walk(rules);
    }
    const fonts: { family: string; status: string }[] = [];
    for (const f of Array.from(document.fonts as unknown as Iterable<FontFace>)) {
      const family = f.family.replace(/^["']|["']$/g, "").trim().toLowerCase();
      if (!families.has(family)) continue;
      try {
        await f.load();
      } catch {
        /* status says error */
      }
      fonts.push({ family, status: f.status });
    }
    const h1 = document.querySelector("h1");
    // Each engine names its default serif differently (WebKit -webkit-standard, Chromium Times): one name.
    let h1Font = h1 ? getComputedStyle(h1).fontFamily.split(",")[0].replace(/^["'\s]+|["'\s]+$/g, "").toLowerCase() : null;
    if (h1Font && ["-webkit-standard", "times", "times new roman", "serif"].includes(h1Font)) h1Font = "(browser default serif)";
    // Normalise the colour through a canvas, so rgb()/oklch()/color() spellings compare equal.
    let bg = getComputedStyle(document.body).backgroundColor;
    if (/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(bg)) bg = getComputedStyle(document.documentElement).backgroundColor;
    let bodyBackground: number[] | null = null;
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1, 1);
      bodyBackground = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    } catch {
      bodyBackground = null;
    }
    return { emptyStylesheets, fonts, h1Font, bodyBackground };
  });
}

export interface WebkitRoute {
  path: string;
  page_errors: string[];
  failed_requests: string[];
  csp_blocked: string[];
  empty_stylesheets: string[];
  fonts_not_loaded: string[];
  h1_font: { webkit: string | null; chromium: string | null } | null;
  body_background: { webkit: number[] | null; chromium: number[] | null } | null;
  screenshot: string | null;
  problems: string[];
}

export interface WebkitGateOptions {
  /** Directory for fold screenshots (`<dir>/webkit-iphone/<route>.png`); none saved without it. */
  evidenceDir?: string | null;
  /** Chromium for the computed-style comparison; skipped (noted) without it. */
  chromium?: Browser | null;
  /** Pre-launched WebKit (tests); launched and closed here otherwise. */
  webkit?: Browser | null;
}

const colourClose = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 2);

export async function webkitIphoneGate(base: string | null, paths: string[], why = "no site to check", opts: WebkitGateOptions = {}): Promise<Gate> {
  const id = "webkit-iphone";
  if (!base) return gate(id, "fail", `cannot run: ${why}`);
  if (paths.length === 0) return gate(id, "fail", "cannot run: no routes to load");
  let webkit = opts.webkit ?? null;
  const own = !webkit;
  if (!webkit) {
    const avail = await webkitAvailable();
    if (!avail.ok) return gate(id, "fail", `cannot run: WebKit unavailable: ${avail.reason}`);
    try {
      webkit = await launchWebkit();
    } catch (e) {
      return gate(id, "fail", `cannot run: WebKit did not start: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const origin = new URL(base).origin;
  const profile = await iphoneProfile();
  const shotDir = opts.evidenceDir ? join(opts.evidenceDir, "webkit-iphone") : null;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const routes: WebkitRoute[] = [];
  const ignored = new Set<string>();
  const context = await webkit.newContext(profile);
  const chromeContext = opts.chromium ? await opts.chromium.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: profile.userAgent }) : null;
  try {
    for (const path of paths) {
      const url = new URL(path.replace(/^\//, ""), base).toString();
      const r: WebkitRoute = { path, page_errors: [], failed_requests: [], csp_blocked: [], empty_stylesheets: [], fonts_not_loaded: [], h1_font: null, body_background: null, screenshot: null, problems: [] };
      const page = await context.newPage();
      page.on("pageerror", (e) => r.page_errors.push(e.message.split("\n")[0].slice(0, 300)));
      page.on("requestfailed", (q) => {
        if (isHostInjected(q.url(), origin)) return void ignored.add(q.url());
        if (new URL(q.url()).origin === origin) r.failed_requests.push(`${q.url().replace(origin, "")} (${q.failure()?.errorText ?? "failed"})`);
      });
      page.on("response", (res) => {
        if (res.status() < 400) return;
        if (isHostInjected(res.url(), origin)) return void ignored.add(res.url());
        if (new URL(res.url()).origin === origin) r.failed_requests.push(`${res.url().replace(origin, "")} (status ${res.status()})`);
      });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        if (!/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(text)) return;
        const urls = [...text.matchAll(/https?:\/\/[^\s'"]+/g)].map((x) => x[0].replace(/[.,;)]+$/, ""));
        const mine = urls.filter((u) => {
          try {
            return new URL(u).origin === origin && !isHostInjected(u, origin);
          } catch {
            return false;
          }
        });
        if (mine.length) r.csp_blocked.push(text.slice(0, 300));
        else ignored.add(`console: ${text.slice(0, 160)}`);
      });
      try {
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        const p = await probe(page);
        r.empty_stylesheets = p.emptyStylesheets;
        r.fonts_not_loaded = p.fonts.filter((f) => f.status !== "loaded").map((f) => `${f.family} (${f.status})`);
        if (shotDir) {
          const file = join(shotDir, `${routeFile(path)}.png`);
          await page.screenshot({ path: file });
          r.screenshot = `webkit-iphone/${routeFile(path)}.png`;
        }
        if (chromeContext) {
          const cp = await chromeContext.newPage();
          try {
            await cp.goto(url, { waitUntil: "load", timeout: 30_000 });
            const c = await probe(cp);
            r.h1_font = { webkit: p.h1Font, chromium: c.h1Font };
            r.body_background = { webkit: p.bodyBackground, chromium: c.bodyBackground };
            if (p.h1Font !== c.h1Font) r.problems.push(`h1 font differs from Chromium: ${p.h1Font ?? "none"} vs ${c.h1Font ?? "none"}`);
            if (p.bodyBackground && c.bodyBackground && !colourClose(p.bodyBackground, c.bodyBackground))
              r.problems.push(`body background differs from Chromium: rgba(${p.bodyBackground.join(",")}) vs rgba(${c.bodyBackground.join(",")})`);
          } finally {
            await cp.close().catch(() => undefined);
          }
        }
      } catch (e) {
        r.problems.push(`did not load: ${(e as Error).message.split("\n")[0]}`);
      } finally {
        await page.close().catch(() => undefined);
      }
      if (r.page_errors.length) r.problems.push(`page error: ${r.page_errors[0]}`);
      for (const f of r.failed_requests) r.problems.push(`request failed: ${f}`);
      for (const s of r.empty_stylesheets) r.problems.push(`stylesheet has no CSS rules: ${s}`);
      for (const f of r.fonts_not_loaded) r.problems.push(`font did not load: ${f}`);
      if (r.csp_blocked.length) r.problems.push(`CSP blocks a same-origin resource: ${r.csp_blocked[0]}`);
      routes.push(r);
    }
  } finally {
    await context.close().catch(() => undefined);
    await chromeContext?.close().catch(() => undefined);
    if (own) await webkit.close().catch(() => undefined);
  }
  const bad = routes.filter((r) => r.problems.length);
  const metrics = {
    routes: routes.length,
    failing_routes: bad.length,
    page_errors: routes.reduce((n, r) => n + r.page_errors.length, 0),
    failed_requests: routes.reduce((n, r) => n + r.failed_requests.length, 0),
    screenshots: routes.filter((r) => r.screenshot).length,
  };
  const details: Record<string, unknown> = { device: IPHONE, engine: "webkit", routes };
  if (ignored.size) details.ignored = [...ignored].slice(0, 20);
  if (!opts.chromium) details.note = "Chromium unavailable: computed-style comparison skipped";
  if (!shotDir) details.screenshots = "not saved (no evidence directory)";
  if (bad.length) return gate(id, "fail", `${bad.length} of ${routes.length} routes break in WebKit (${IPHONE}): ${bad[0].path}: ${bad[0].problems[0]}`, metrics, details);
  return gate(id, "pass", `${routes.length} routes render in WebKit (${IPHONE}) with no errors; ${opts.chromium ? "h1 font and background match Chromium" : "Chromium comparison skipped"}`, metrics, details);
}
