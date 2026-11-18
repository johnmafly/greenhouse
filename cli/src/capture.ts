// greenhouse capture: freeze an evidence bundle for a judged round.
// Reviewers only ever see this bundle, never the live site (plan v7 section 5).
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MANIFEST_FILE,
  buildManifest,
  insideGitCheckout,
  serializeManifest,
  verifyBundle,
  type Manifest,
} from "./capture-manifest.ts";
import { parseR2Target, uploadBundle } from "./capture-r2.ts";
import { loadContentMap, routesFromContentMap, stripAnchor, type ContentMap, type ContentServe } from "./capture-routes.ts";
import { DEFAULT_MOTION_TIMING, captureMotion, motionTargets, type MotionEntry, type MotionTiming } from "./capture-motion.ts";
import { collectWebkitEvidence, type WebkitEvidence, type WebkitSource } from "./capture-webkit.ts";
import { DOCS_DIR, markdownAlternateInPage, parseDocsMap, planDocs, saveLlmsTxt, saveMarkdownAlternate, type DocsMap, type DocsServe, type LlmsTxt, type MarkdownResult } from "./capture-docs.ts";
import { DOCS_KEYS } from "./check/docs.ts";

/**
 * Contract v1 routes. Used when the project declares no content map (greenhouse.yaml
 * `content:`, contract v2); with one, capture visits "/" plus the map's paths.
 */
export const CONTRACT_ROUTES = [
  "/",
  "/docs/",
  "/docs/how-it-works/",
  "/docs/comparison/",
  "/docs/getting-started/",
  "/docs/architecture/",
  "/docs/integration/",
  "/pricing/",
  "/signup/",
];

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;

const WELL_KNOWN = "/.well-known/greenhouse.json";
// 2: pages[].content, route_source, content_map, motion[] (design bar v2).
// 3: webkit_iphone (greenhouse check's WebKit iPhone screenshots, copied into webkit-iphone/).
// 4: docs (the user guide named by greenhouse.yaml's docs: block, frozen into docs/), and
//    pages[].docs / files.markdown / markdown_alternate on pages that are also guide pages.
//    Without a docs: block a v4 manifest has the same fields as v3.
export const MANIFEST_SCHEMA_VERSION = 4;

const USAGE = `greenhouse capture --url <deployment> --out <bundle dir> [options]
greenhouse capture --verify <bundle dir>

Freeze an evidence bundle: full-page screenshots of every route at desktop (1440x900)
and mobile (390x844), the visible text of each page, motion evidence for the home page
and the signup start (scroll video webm and 12-frame strip PNG at desktop and phone, plus
a reduced-motion strip of the home page), greenhouse check's WebKit iPhone screenshots when
--round-dir or --evidence-dir names them, the user guide when greenhouse.yaml has a docs:
block, and manifest.json with the sha256 of every file and a bundle hash.

Options:
  --url <url>            Deployment base URL (required)
  --out <dir>            New bundle directory; must not exist (or be empty) and must be
                         outside every git checkout (decision 0002)
  --greenhouse-yaml <f>  The project's greenhouse.yaml (or its checkout directory). Routes
                         become "/" plus the distinct paths of its content map (contract v2,
                         anchors dropped), and each page records the content keys it serves;
                         motion uses content.signup as the signup start. Without this option,
                         or when the file has no content: map, the contract v1 routes are
                         captured and /signup/ is the signup start. A malformed map is an error.
                         With a docs: block (decision 0006), every distinct guide path (lists
                         flattened, anchors dropped) not already captured as a route is frozen in
                         docs/<NN>-<section>/: text.txt (visible text, as for pages), desktop.png
                         (full page, desktop only) and page.md (the page's same-origin
                         <link rel="alternate" type="text/markdown">, when it has one). A guide path
                         that is also a route keeps its pages/ files, gains pages/<name>/page.md and
                         lists its sections in pages[].docs. /llms.txt is saved as docs/llms.txt
                         when served. manifest.json's docs records section -> paths -> files.
  --routes <a,b,...>     Routes to capture instead (not with --greenhouse-yaml)
  --round-dir <dir>      The round dir \`greenhouse check --round-dir\` wrote: its WebKit iPhone 15 Pro
                         fold screenshots (<dir>/evidence/webkit-iphone/*.png) are copied into the
                         bundle's webkit-iphone/, with each route, its problems and the gate result
                         from <dir>/checks.json, recorded in the manifest's webkit_iphone
  --evidence-dir <dir>   Instead of --round-dir, for a check run without one: the evidence dir
                         holding webkit-iphone/ (~/.greenhouse/evidence/<slug>-<sha12>)
  --r2 <bucket>/<prefix> Also upload to R2 with content-addressed keys <prefix>/sha256/<hash>.
                         Needs CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID if the token
                         sees more than one account) in the environment.
  --timeout <ms>         Per-page navigation timeout (default 45000)
  --verify <dir>         Recompute every hash in an existing bundle and exit 0 if it matches
Env CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, when set, are sent as Cloudflare Access
service-token headers (never recorded in the bundle).
`;

export function routeName(route: string, index: number): string {
  const slug = route.replace(/[?#].*$/, "").split("/").filter(Boolean).join("-").replace(/[^a-zA-Z0-9._-]/g, "_") || "home";
  return `${String(index + 1).padStart(2, "0")}-${slug}`;
}

export function parseRoutes(spec: string | undefined): string[] {
  if (!spec) return CONTRACT_ROUTES;
  const routes = spec.split(",").map((r) => r.trim()).filter(Boolean);
  for (const r of routes) if (!r.startsWith("/")) throw new Error(`route must start with '/': ${r}`);
  if (routes.length === 0) throw new Error("--routes is empty");
  return routes;
}

/**
 * Runs in the page. Returns text a sighted person can see, one line per block, and the
 * number of characters skipped as hidden (display/visibility/opacity, zero-size, clipped
 * "sr-only" text, transparent or tiny font, or positioned off the page).
 */
function extractVisibleText(): { text: string; hidden_chars: number } {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const docW = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  const docH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  const sx = window.scrollX;
  const sy = window.scrollY;
  const hiddenCache = new Map<Element, boolean>();

  function clippedAway(el: Element): boolean {
    if (hiddenCache.has(el)) return hiddenCache.get(el)!;
    let hidden = false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const tiny = r.width <= 1 || r.height <= 1;
    if (cs.overflow !== "visible" && tiny && cs.display !== "contents") hidden = true;
    if (/rect\(0(px)?,?\s*0(px)?,?\s*0(px)?,?\s*0(px)?\)/.test(cs.clip)) hidden = true;
    if (/inset\(50%\)/.test(cs.clipPath)) hidden = true;
    if (!hidden && el.parentElement) hidden = clippedAway(el.parentElement);
    hiddenCache.set(el, hidden);
    return hidden;
  }

  function visible(node: Text): boolean {
    const el = node.parentElement;
    if (!el) return false;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.fontSize) < 4) return false;
    if (/rgba\(.*,\s*0\)$/.test(cs.color) || cs.color === "transparent") return false;
    if (clippedAway(el)) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const left = r.left + sx;
      const top = r.top + sy;
      if (left + r.width > 0 && top + r.height > 0 && left < docW && top < docH) return true;
    }
    return false;
  }

  function blockOf(el: Element | null): Element | null {
    while (el && el !== document.body) {
      const d = getComputedStyle(el).display;
      if (!d.startsWith("inline") && d !== "contents") return el;
      el = el.parentElement;
    }
    return document.body;
  }

  const lines: string[] = [];
  let current = "";
  let currentBlock: Element | null = null;
  let hidden = 0;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let p = n.parentElement; p; p = p.parentElement) if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const raw = (n.data ?? "").replace(/\s+/g, " ");
    if (!raw.trim()) continue;
    if (!visible(n)) {
      hidden += raw.trim().length;
      continue;
    }
    const block = blockOf(n.parentElement);
    if (block !== currentBlock) {
      if (current.trim()) lines.push(current.trim());
      current = "";
      currentBlock = block;
    }
    current += raw;
  }
  if (current.trim()) lines.push(current.trim());
  return { text: lines.map((l) => l.replace(/ {2,}/g, " ")).join("\n") + (lines.length ? "\n" : ""), hidden_chars: hidden };
}

type PageRecord = {
  route: string;
  url: string;
  final_url: string;
  status: number | null;
  title: string;
  /** markdown only on a guide page (docs: block): its saved Markdown alternate, or null. */
  files: { desktop: string; mobile: string; text: string; markdown?: string | null };
  /** Content keys this page serves (target keeps the #anchor); null without a content map. */
  content: ContentServe[] | null;
  /** Docs sections this page serves; only present when the docs: block names this route. */
  docs?: DocsServe[];
  /** The page's Markdown alternate; only present with docs. */
  markdown_alternate?: MarkdownResult;
  hidden_text_chars: number;
  /** CSS width the page laid out at on the phone; above 390 means it lacks a mobile viewport. */
  mobile_layout_width: number | null;
};

/** A guide page capture visited for the docs: block (not already a route), under docs/<NN>-<key>/. */
type DocsPageRecord = {
  path: string;
  url: string;
  final_url: string;
  status: number | null;
  title: string;
  docs: DocsServe[];
  files: { desktop: string; text: string; markdown: string | null };
  markdown_alternate: MarkdownResult;
  hidden_text_chars: number;
};

type DocsFiles = { text: string; desktop: string; markdown: string | null };

/** manifest.docs: the docs: block and where each section's pages are in the bundle. */
type DocsEvidence = {
  source: "greenhouse.yaml docs:";
  /** Problems with the docs: block (missing or unknown sections, bad paths); valid entries are still captured. */
  errors: string[];
  /** Section key -> its paths (as written, #anchor kept) -> the bundle files holding that page. */
  sections: Record<string, { target: string; path: string; files: DocsFiles }[]>;
  /** The guide pages visited for the docs: block (not already routes), in visit order. */
  pages: DocsPageRecord[];
  llms_txt: LlmsTxt;
};

function accessHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return { "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET };
  }
  return {};
}

async function settle(page: import("playwright").Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  // Scroll through once so lazy content loads, then return to the top.
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40_000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
}

export type CaptureOptions = {
  url: string;
  out: string;
  routes?: string[];
  /** greenhouse.yaml content map (contract v2); routes and the signup start come from it. */
  contentMap?: ContentMap | null;
  /** greenhouse.yaml docs: block (decision 0006); its guide pages are frozen into docs/. */
  docsMap?: DocsMap | null;
  /** Where greenhouse check saved its webkit-iphone screenshots; none copied without it. */
  webkit?: WebkitSource | null;
  /** Motion evidence timing overrides, or false to skip motion (tests only). */
  motion?: false | Partial<MotionTiming>;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
};

/** Capture into a temp dir beside out, write the manifest, then rename into place. */
export async function capture(opts: CaptureOptions): Promise<Manifest> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const base = new URL(opts.url);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("--url must be http(s)");
  if (opts.contentMap && opts.routes) throw new Error("routes and a content map are mutually exclusive");
  const fromMap = opts.contentMap ? routesFromContentMap(opts.contentMap) : null;
  const routes = fromMap?.routes ?? opts.routes ?? CONTRACT_ROUTES;
  const routeSource = fromMap ? "content_map" : opts.routes ? "routes_option" : "contract_v1_fallback";
  const signupStart = opts.contentMap ? stripAnchor(opts.contentMap.signup) || "/" : "/signup/";
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const docsPlan = opts.docsMap?.present ? planDocs(opts.docsMap, routes) : null;
  const out = resolve(opts.out);
  await assertUsableOut(out);
  const tmp = `${out}.partial-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const { chromium } = await import("playwright");
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const browser = await chromium.launch();
  try {
    const headers = accessHeaders(env);
    const contexts = {
      desktop: await browser.newContext({ viewport: { width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height }, deviceScaleFactor: VIEWPORTS.desktop.deviceScaleFactor, isMobile: false, hasTouch: false, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", extraHTTPHeaders: headers }),
      mobile: await browser.newContext({ viewport: { width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height }, deviceScaleFactor: VIEWPORTS.mobile.deviceScaleFactor, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", extraHTTPHeaders: headers }),
    };

    // Deployment identity (/.well-known/greenhouse.json), recorded when present.
    let deployment: unknown = null;
    const wk = await contexts.desktop.request.get(new URL(WELL_KNOWN, base).toString(), { timeout: timeoutMs }).catch(() => null);
    if (wk && wk.ok()) {
      const body = await wk.body();
      try {
        deployment = JSON.parse(body.toString("utf8"));
        await writeFile(join(tmp, "well-known-greenhouse.json"), body);
      } catch {
        deployment = null;
      }
    }

    const pages: PageRecord[] = [];
    for (const [i, route] of routes.entries()) {
      const name = routeName(route, i);
      const dir = join(tmp, "pages", name);
      await mkdir(dir, { recursive: true });
      const url = new URL(route, base).toString();
      const rec: PageRecord = { route, url, final_url: url, status: null, title: "", files: { desktop: `pages/${name}/desktop.png`, mobile: `pages/${name}/mobile.png`, text: `pages/${name}/text.txt` }, content: fromMap ? (fromMap.serves.get(route) ?? []) : null, hidden_text_chars: 0, mobile_layout_width: null };
      for (const vp of ["desktop", "mobile"] as const) {
        const page = await contexts[vp].newPage();
        try {
          const resp = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
          await settle(page);
          await page.screenshot({ path: join(tmp, rec.files[vp]), fullPage: true, animations: "disabled", caret: "hide" });
          if (vp === "desktop") {
            rec.status = resp?.status() ?? null;
            rec.final_url = page.url();
            rec.title = await page.title();
            const { text, hidden_chars } = await page.evaluate(extractVisibleText);
            rec.hidden_text_chars = hidden_chars;
            await writeFile(join(tmp, rec.files.text), text);
            const docsServed = docsPlan?.shared.get(route);
            if (docsServed) {
              rec.docs = docsServed;
              const md = await saveMarkdownAlternate(await page.evaluate(markdownAlternateInPage), base, contexts.desktop.request, tmp, `pages/${name}/page.md`, timeoutMs);
              rec.files.markdown = md.file;
              rec.markdown_alternate = md;
            }
          } else {
            rec.mobile_layout_width = await page.evaluate(() => document.documentElement.clientWidth);
          }
        } catch (e) {
          throw new Error(`capture of ${url} (${vp}) failed: ${(e as Error).message.split("\n")[0]}`);
        } finally {
          await page.close();
        }
      }
      log(`captured ${route} -> HTTP ${rec.status}${rec.status !== null && rec.status >= 400 ? " (recorded, not an error)" : ""}`);
      pages.push(rec);
    }

    let docs: DocsEvidence | undefined;
    if (docsPlan && opts.docsMap) {
      for (const e of opts.docsMap.errors) log(`docs: ${e}`);
      const docsPages: DocsPageRecord[] = [];
      for (const t of docsPlan.targets) {
        const dir = `${DOCS_DIR}/${t.name}`;
        await mkdir(join(tmp, dir), { recursive: true });
        const url = new URL(t.path, base).toString();
        const rec: DocsPageRecord = { path: t.path, url, final_url: url, status: null, title: "", docs: t.serves, files: { desktop: `${dir}/desktop.png`, text: `${dir}/text.txt`, markdown: null }, markdown_alternate: { url: null, status: null, file: null, note: null }, hidden_text_chars: 0 };
        const page = await contexts.desktop.newPage();
        try {
          const resp = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
          await settle(page);
          await page.screenshot({ path: join(tmp, rec.files.desktop), fullPage: true, animations: "disabled", caret: "hide" });
          rec.status = resp?.status() ?? null;
          rec.final_url = page.url();
          rec.title = await page.title();
          const { text, hidden_chars } = await page.evaluate(extractVisibleText);
          rec.hidden_text_chars = hidden_chars;
          await writeFile(join(tmp, rec.files.text), text);
          rec.markdown_alternate = await saveMarkdownAlternate(await page.evaluate(markdownAlternateInPage), base, contexts.desktop.request, tmp, `${dir}/page.md`, timeoutMs);
          rec.files.markdown = rec.markdown_alternate.file;
        } catch (e) {
          throw new Error(`capture of docs page ${url} failed: ${(e as Error).message.split("\n")[0]}`);
        } finally {
          await page.close();
        }
        log(`captured docs ${t.path} (${t.serves.map((s) => s.key).join(", ")}) -> HTTP ${rec.status}${rec.files.markdown ? ", Markdown saved" : rec.markdown_alternate.note ? `, Markdown not saved: ${rec.markdown_alternate.note}` : ", no Markdown alternate linked"}`);
        docsPages.push(rec);
      }
      const filesFor = new Map<string, DocsFiles>();
      for (const p of docsPages) filesFor.set(p.path, p.files);
      for (const p of pages) if (p.docs) filesFor.set(p.route, { text: p.files.text, desktop: p.files.desktop, markdown: p.files.markdown ?? null });
      const sections: DocsEvidence["sections"] = {};
      for (const key of DOCS_KEYS) {
        const refs = opts.docsMap.sections.get(key);
        if (refs) sections[key] = refs.map((r) => ({ target: r.raw, path: r.path, files: filesFor.get(r.path)! }));
      }
      const llms = await saveLlmsTxt(base, contexts.desktop.request, tmp, timeoutMs);
      log(`docs: ${docsPages.length} guide page(s) captured, ${docsPlan.shared.size} shared with routes; /llms.txt ${llms.file ? "saved" : `not saved (${llms.note})`}`);
      docs = { source: "greenhouse.yaml docs:", errors: opts.docsMap.errors, sections, pages: docsPages, llms_txt: llms };
    }

    let motion: MotionEntry[] = [];
    const timing = opts.motion === false ? null : { ...DEFAULT_MOTION_TIMING, ...opts.motion };
    if (timing) {
      motion = await captureMotion({ browser, base, tmp, targets: motionTargets(signupStart), viewports: VIEWPORTS, headers, timing, timeoutMs: opts.timeoutMs ?? 45_000, log });
    }

    let webkitIphone: WebkitEvidence | null = null;
    if (opts.webkit) {
      webkitIphone = await collectWebkitEvidence(opts.webkit, tmp, routes);
      const deployedSha = (deployment as { sha?: unknown } | null)?.sha;
      if (webkitIphone.checked_sha && typeof deployedSha === "string" && webkitIphone.checked_sha !== deployedSha) {
        webkitIphone.notes.push(`checks.json sha ${webkitIphone.checked_sha} differs from the deployed sha ${deployedSha}`);
      }
      for (const n of webkitIphone.notes) log(`webkit-iphone: ${n}`);
      log(`webkit-iphone: ${webkitIphone.screenshots.length} screenshot(s) copied`);
    }

    const manifest = await buildManifest(tmp, {
      schema_version: MANIFEST_SCHEMA_VERSION,
      kind: "greenhouse-evidence-bundle",
      url: base.toString(),
      captured_at: new Date().toISOString(),
      tool: { name: "greenhouse capture", playwright: playwrightVersion, browser: `chromium ${browser.version()}`, node: process.version },
      access_service_token: Object.keys(headers).length > 0,
      viewports: VIEWPORTS,
      text_source: "desktop render, visible text only",
      deployment,
      route_source: routeSource,
      content_map: opts.contentMap ?? null,
      pages,
      motion_timing: timing,
      motion,
      webkit_iphone: webkitIphone,
      ...(docs ? { docs } : {}),
    });
    await writeFile(join(tmp, MANIFEST_FILE), serializeManifest(manifest));
    await rm(out, { recursive: true, force: true }); // only an empty dir can exist here (assertUsableOut)
    await rename(tmp, out);
    return manifest;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    await browser.close();
  }
}

async function assertUsableOut(out: string): Promise<void> {
  const repo = await insideGitCheckout(dirname(out));
  if (repo) throw new Error(`--out must be outside every git checkout (decision 0002); ${out} is inside ${repo}`);
  try {
    const ents = await readdir(out);
    if (ents.length > 0) throw new Error(`--out ${out} already exists and is not empty; bundles are never overwritten`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(dirname(out), { recursive: true });
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        out: { type: "string" },
        routes: { type: "string" },
        "greenhouse-yaml": { type: "string" },
        "round-dir": { type: "string" },
        "evidence-dir": { type: "string" },
        r2: { type: "string" },
        timeout: { type: "string" },
        verify: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }).values;
  } catch (e) {
    process.stderr.write(`greenhouse capture: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.verify) {
    const r = await verifyBundle(resolve(args.verify));
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return r.ok ? 0 : 1;
  }
  if (!args.url || !args.out) {
    process.stderr.write(`greenhouse capture: --url and --out are required\n\n${USAGE}`);
    return 2;
  }
  if (!isAbsolute(args.out)) process.stderr.write(`note: --out resolved to ${resolve(args.out)}\n`);
  let target;
  let routes;
  let contentMap: ContentMap | null = null;
  let docsMap: DocsMap | null = null;
  let webkit: WebkitSource | null = null;
  try {
    target = args.r2 ? parseR2Target(args.r2) : null;
    if (args["greenhouse-yaml"] && args.routes) throw new Error("--routes and --greenhouse-yaml are mutually exclusive");
    if (args["greenhouse-yaml"]) {
      const loaded = await loadContentMap(resolve(args["greenhouse-yaml"]));
      contentMap = loaded.map;
      if (!contentMap) process.stderr.write(`note: ${loaded.file} has no content: map; capturing the contract v1 routes\n`);
      const docs = parseDocsMap(loaded.doc);
      docsMap = docs.present ? docs : null;
    }
    routes = contentMap || !args.routes ? undefined : parseRoutes(args.routes);
    if (args["round-dir"] && args["evidence-dir"]) throw new Error("--round-dir and --evidence-dir are mutually exclusive");
    if (args["round-dir"]) webkit = { roundDir: resolve(args["round-dir"]) };
    else if (args["evidence-dir"]) webkit = { evidenceDir: resolve(args["evidence-dir"]) };
    const webkitDir = webkit?.roundDir ?? webkit?.evidenceDir;
    if (webkitDir && !existsSync(webkitDir)) throw new Error(`${webkitDir} does not exist`);
    if (target && !process.env.CLOUDFLARE_API_TOKEN) throw new Error("--r2 needs CLOUDFLARE_API_TOKEN in the environment");
  } catch (e) {
    process.stderr.write(`greenhouse capture: ${(e as Error).message}\n`);
    return 2;
  }
  try {
    const out = resolve(args.out);
    const manifest = await capture({ url: args.url, out, routes, contentMap, docsMap, webkit, timeoutMs: args.timeout ? Number(args.timeout) : undefined });
    const summary: Record<string, unknown> = { out, bundle_hash: manifest.bundle_hash, files: manifest.files.length };
    if (target) {
      const up = await uploadBundle(out, manifest, target);
      summary.r2 = { bucket: up.bucket, objects: up.objects.length, manifest_key: up.objects[up.objects.length - 1].key };
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`greenhouse capture: ${(e as Error).message}\n`);
    return 1;
  }
}
