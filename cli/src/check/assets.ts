// asset-cache: no browser may keep a stale stylesheet, script, module or font under new HTML.
//
// Every same-origin asset the pages load must either carry a content fingerprint in its URL (a hash
// token in the file name, or a hash-like query value such as ?v=3f9a1c2b) or be served so browsers
// revalidate it (Cache-Control no-store, no-cache or max-age=0). An unversioned asset with a positive
// max-age, `immutable`, or no Cache-Control at all (browsers then cache heuristically, and a
// Cloudflare zone's Browser Cache TTL can add hours) fails: a visitor who saw the old version keeps
// the old file under the new HTML. That is how BotRampart v2 rendered with v1's site.css on an
// iPhone (unversioned /assets/site.css, max-age=14400).
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { tags } from "./html.ts";
import { htmlPages } from "./site.ts";
import type { Site } from "./site.ts";

export type AssetKind = "stylesheet" | "script" | "module" | "font" | "preload";

export interface AssetRef {
  url: string;
  kind: AssetKind;
  /** Page or asset that referenced it (path). */
  from: string;
}

/** A token that looks like a content hash: 8+ hex chars, or 8-22 base64url chars mixing case and digits (Vite, esbuild). */
export function hashLike(token: string, minHex = 8): boolean {
  if (new RegExp(`^[0-9a-f]{${minHex},64}$`, "i").test(token)) return true;
  return /^[A-Za-z0-9_-]{8,22}$/.test(token) && /\d/.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token);
}

/** Whether the URL carries a content fingerprint: in the file name (site.3f9a1c2b.css, index-BxK3a9Zq.js) or a query value (?v=3f9a1c2). */
export function fingerprinted(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url, "http://x/");
  } catch {
    return false;
  }
  const file = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
  const candidates = new Set<string>();
  for (const part of stem.split(".")) {
    candidates.add(part);
    const dash = part.indexOf("-");
    if (dash >= 0) {
      candidates.add(part.slice(dash + 1));
      candidates.add(part.slice(part.lastIndexOf("-") + 1));
    }
    const us = part.lastIndexOf("_");
    if (us >= 0) candidates.add(part.slice(us + 1));
  }
  for (const c of candidates) if (hashLike(c)) return true;
  // A short git sha (7 hex) also changes on every deploy, so ?v=<sha7> is accepted in a query.
  for (const v of u.searchParams.values()) if (hashLike(v, 7)) return true;
  return false;
}

export interface CachePolicy {
  /** Browsers must revalidate before reuse: no-store, no-cache, or max-age=0 (without immutable). */
  revalidates: boolean;
  /** Human-readable reason when it does not. */
  reason: string;
}

export function cachePolicy(cacheControl: string | undefined): CachePolicy {
  if (!cacheControl || !cacheControl.trim()) return { revalidates: false, reason: "no Cache-Control: browsers cache it heuristically and a CDN may add a TTL" };
  const cc = cacheControl.toLowerCase();
  const immutable = /(^|[\s,])immutable\b/.test(cc);
  if (/(^|[\s,])no-store\b/.test(cc)) return { revalidates: true, reason: "no-store" };
  if (/(^|[\s,])no-cache\b/.test(cc) && !immutable) return { revalidates: true, reason: "no-cache" };
  const m = /(?:^|[\s,])max-age\s*=\s*"?(\d+)/.exec(cc);
  if (immutable) return { revalidates: false, reason: "immutable on an unversioned URL" };
  if (m && Number(m[1]) === 0) return { revalidates: true, reason: "max-age=0" };
  if (m) return { revalidates: false, reason: `max-age=${m[1]} on an unversioned URL` };
  return { revalidates: false, reason: "Cache-Control without max-age=0, no-cache or no-store: browsers cache it heuristically" };
}

/** Same-origin assets an HTML page loads: stylesheets, scripts and modules, preloads (fonts included). */
export function pageAssets(html: string, pageUrl: string, origin: string, from: string): AssetRef[] {
  const out: AssetRef[] = [];
  const add = (ref: string | undefined, kind: AssetKind) => {
    const url = sameOrigin(ref, pageUrl, origin);
    if (url) out.push({ url, kind, from });
  };
  for (const l of tags(html, "link")) {
    const rel = (l.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet")) add(l.href, "stylesheet");
    else if (rel.includes("modulepreload")) add(l.href, "module");
    else if (rel.includes("preload")) add(l.href, (l.as ?? "").toLowerCase() === "font" ? "font" : "preload");
  }
  // tags() strips script bodies but keeps the start tag of an external script.
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]));
    if (!attrs.src) continue;
    add(attrs.src, (attrs.type ?? "").toLowerCase() === "module" ? "module" : "script");
  }
  return out;
}

/** Fonts and nested stylesheets a stylesheet loads (url() in @font-face, @import). */
export function cssAssets(css: string, cssUrl: string, origin: string): AssetRef[] {
  const out: AssetRef[] = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?/gi)) {
    const url = sameOrigin(m[1], cssUrl, origin);
    if (url) out.push({ url, kind: "stylesheet", from: pathOf(cssUrl) });
  }
  for (const face of body.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    for (const m of face[1].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      const url = sameOrigin(m[1], cssUrl, origin);
      if (url) out.push({ url, kind: "font", from: pathOf(cssUrl) });
    }
  }
  return out;
}

/** Modules a script imports statically (import/export ... from "x", import "x") or with a literal import("x"). */
export function jsImports(js: string, jsUrl: string, origin: string): AssetRef[] {
  const out: AssetRef[] = [];
  const src = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  const specs = [
    ...src.matchAll(/(?:^|[;\s}])(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g),
    ...src.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g),
  ].map((m) => m[1]);
  for (const s of specs) {
    if (!/^(\.{0,2}\/|https?:)/.test(s)) continue; // bare specifiers cannot load in a browser without an import map
    const url = sameOrigin(s, jsUrl, origin);
    if (url) out.push({ url, kind: "module", from: pathOf(jsUrl) });
  }
  return out;
}

function sameOrigin(ref: string | undefined, base: string, origin: string): string | null {
  if (!ref || /^(data|blob|javascript):/i.test(ref.trim())) return null;
  try {
    const u = new URL(ref.trim(), base);
    if (u.origin !== origin) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

export interface AssetResult {
  url: string;
  path: string;
  kind: AssetKind;
  from: string;
  status: number | null;
  cache_control: string | null;
  fingerprinted: boolean;
  ok: boolean;
  reason: string;
}

type Fetcher = (url: string) => Promise<{ status: number; headers: Headers; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });

/** Crawl every same-origin asset the site's pages load (following CSS @import/fonts and JS imports) and judge its caching. */
export async function assetCacheGate(site: Site | null, why = "no site to check", fetcher: Fetcher = defaultFetch, maxAssets = 300): Promise<Gate> {
  const id = "asset-cache";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  const pages = htmlPages(site);
  if (pages.length === 0) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const origin = new URL(site.base).origin;
  const queue: AssetRef[] = [];
  for (const p of pages) queue.push(...pageAssets(p.body, p.url, origin, p.path));
  const seen = new Map<string, AssetResult>();
  while (queue.length && seen.size < maxAssets) {
    const ref = queue.shift() as AssetRef;
    if (seen.has(ref.url)) continue;
    const r: AssetResult = { url: ref.url, path: pathOf(ref.url), kind: ref.kind, from: ref.from, status: null, cache_control: null, fingerprinted: fingerprinted(ref.url), ok: false, reason: "" };
    seen.set(ref.url, r);
    let body = "";
    let type = "";
    try {
      const res = await fetcher(ref.url);
      r.status = res.status;
      r.cache_control = res.headers.get("cache-control");
      type = res.headers.get("content-type") ?? "";
      body = res.status < 400 ? await res.text() : "";
    } catch (e) {
      r.reason = `cannot fetch: ${(e as Error).message}`;
      continue;
    }
    if ((r.status as number) >= 400) {
      r.reason = `status ${r.status}`;
      continue;
    }
    if (r.fingerprinted) {
      r.ok = true;
      r.reason = "fingerprinted URL";
    } else {
      const pol = cachePolicy(r.cache_control ?? undefined);
      r.ok = pol.revalidates;
      r.reason = pol.revalidates ? `unversioned URL, revalidated (${pol.reason})` : pol.reason;
    }
    const isCss = /text\/css/i.test(type) || /\.css$/i.test(new URL(ref.url).pathname);
    const isJs = /javascript|ecmascript/i.test(type) || /\.(m?js)$/i.test(new URL(ref.url).pathname);
    if (isCss) queue.push(...cssAssets(body, ref.url, origin));
    else if (isJs && (ref.kind === "module" || /\bimport\b/.test(body))) queue.push(...jsImports(body, ref.url, origin));
  }
  const assets = [...seen.values()];
  const offenders = assets.filter((a) => !a.ok);
  const metrics = {
    assets: assets.length,
    fingerprinted: assets.filter((a) => a.fingerprinted).length,
    revalidated: assets.filter((a) => a.ok && !a.fingerprinted).length,
    offenders: offenders.length,
  };
  const show = (a: AssetResult) => ({ url: a.path, kind: a.kind, from: a.from, status: a.status, cache_control: a.cache_control, fingerprinted: a.fingerprinted, reason: a.reason });
  const details = { offenders: offenders.slice(0, 50).map(show), assets: assets.slice(0, 100).map(show) };
  if (assets.length === 0) return gate(id, "pass", `no same-origin stylesheets, scripts, modules, fonts or preloads on ${pages.length} pages`, metrics);
  if (offenders.length) {
    const a = offenders[0];
    return gate(
      id,
      "fail",
      `${offenders.length} of ${assets.length} assets can be served stale under new HTML: ${a.path} (${a.cache_control ? `cache-control: ${a.cache_control}` : a.reason})${offenders.length > 1 ? ` and ${offenders.length - 1} more` : ""}; fingerprint the URL or send Cache-Control: no-cache`,
      metrics,
      details,
    );
  }
  return gate(id, "pass", `${assets.length} assets: ${metrics.fingerprinted} fingerprinted, ${metrics.revalidated} unversioned but revalidated`, metrics, details);
}
