// Fetches the pages of a deployed (or locally served) site so the gates can read them.
import { references } from "./html.ts";

export const REQUIRED_ROUTES = [
  "/",
  "/docs/",
  "/docs/how-it-works/",
  "/docs/comparison/",
  "/docs/getting-started/",
  "/docs/architecture/",
  "/docs/integration/",
  "/pricing/",
  "/signup/",
] as const;

export const DOCS_SECTIONS = [
  "/docs/how-it-works/",
  "/docs/comparison/",
  "/docs/getting-started/",
  "/docs/architecture/",
  "/docs/integration/",
] as const;

export interface Page {
  /** Path the page was requested at, e.g. "/docs/". */
  path: string;
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  /** Response headers, lower-case names. */
  headers: Record<string, string>;
  body: string;
  isHtml: boolean;
}

export interface Site {
  /** Base URL with a trailing slash. */
  base: string;
  /** Fetched pages by requested path, in crawl order. */
  pages: Map<string, Page>;
  /** Paths that could not be fetched at all (network error), with the reason. */
  errors: { path: string; error: string }[];
}

export function normalizeBase(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.toString();
}

/** Same-origin path (with query) for a reference found on `pageUrl`, or null if external or not http. */
export function internalPath(ref: string, pageUrl: string, base: string): string | null {
  if (!ref || ref.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(ref)) return null;
  let u: URL;
  try {
    u = new URL(ref, pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.origin !== new URL(base).origin) return null;
  return u.pathname + u.search;
}

export async function fetchPage(base: string, path: string, method = "GET"): Promise<Page> {
  const url = new URL(path, base).toString();
  const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const contentType = headers["content-type"] ?? "";
  const body = method === "HEAD" ? "" : await res.text();
  return { path, url: res.url || url, status: res.status, contentType, headers, body, isHtml: /text\/html/i.test(contentType) };
}

/**
 * Fetch the required routes, then follow same-origin anchor links to every reachable HTML page
 * (at most `maxPages`).
 */
export async function crawl(baseUrl: string, start: readonly string[] = REQUIRED_ROUTES, maxPages = 200): Promise<Site> {
  const base = normalizeBase(baseUrl);
  const site: Site = { base, pages: new Map(), errors: [] };
  const queue = [...start];
  const seen = new Set<string>(queue);
  while (queue.length && site.pages.size < maxPages) {
    const path = queue.shift() as string;
    let page: Page;
    try {
      page = await fetchPage(base, path);
    } catch (e) {
      site.errors.push({ path, error: (e as Error).message });
      continue;
    }
    site.pages.set(path, page);
    if (!page.isHtml || page.status >= 400) continue;
    for (const ref of references(page.body)) {
      if (ref.tag !== "a") continue;
      const p = internalPath(ref.url, page.url, base);
      if (!p) continue;
      const noQuery = p.split("?")[0];
      if (seen.has(noQuery) || /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|css|js|mjs|json|xml|txt|ya?ml|woff2?|mp4|webm)$/i.test(noQuery)) continue;
      seen.add(noQuery);
      queue.push(noQuery);
    }
  }
  return site;
}

/** HTML pages that loaded (status < 400). */
export function htmlPages(site: Site): Page[] {
  return [...site.pages.values()].filter((p) => p.isHtml && p.status < 400);
}
