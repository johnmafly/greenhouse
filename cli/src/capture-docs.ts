// User guide evidence for greenhouse capture (decision 0006). When greenhouse.yaml has a `docs:`
// block, capture also freezes every guide page it names, so reviewers can judge the guide's depth
// from the bundle alone: the rendered text of each page, its Markdown alternate when the page links
// one on the same origin, a desktop screenshot, and /llms.txt. Without a docs: block nothing here runs.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCS_KEYS, parseDocsMap, type DocsMap } from "./check/docs.ts";

export { parseDocsMap, type DocsMap };

/** Bundle directory holding the guide pages and /llms.txt. */
export const DOCS_DIR = "docs";

/** One docs section a page serves; target keeps the #anchor as written in greenhouse.yaml. */
export type DocsServe = { key: string; target: string };

/** A docs page capture visits itself (its path is not already a captured route). */
export type DocsTarget = { path: string; name: string; serves: DocsServe[] };

export type DocsPlan = {
  /** Distinct docs paths not captured as routes, in section order, each with its bundle dir name. */
  targets: DocsTarget[];
  /** Docs paths that are also captured routes: the keys to record on those page records. */
  shared: Map<string, DocsServe[]>;
};

/** "NN-<key>": the docs dir name, numbered in visit order and named after the first section on it. */
export function docsDirName(key: string, index: number): string {
  return `${String(index + 1).padStart(2, "0")}-${key.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

/**
 * Flatten the docs map (lists flattened, anchors dropped) into distinct paths in section order.
 * A path that is already a captured route is not visited again; its sections go in `shared`.
 */
export function planDocs(map: DocsMap, capturedRoutes: readonly string[]): DocsPlan {
  const captured = new Set(capturedRoutes);
  const serves = new Map<string, DocsServe[]>();
  for (const key of DOCS_KEYS) {
    for (const ref of map.sections.get(key) ?? []) {
      if (!serves.has(ref.path)) serves.set(ref.path, []);
      serves.get(ref.path)!.push({ key, target: ref.raw });
    }
  }
  const targets: DocsTarget[] = [];
  const shared = new Map<string, DocsServe[]>();
  for (const [path, s] of serves) {
    if (captured.has(path)) shared.set(path, s);
    else targets.push({ path, name: docsDirName(s[0].key, targets.length), serves: s });
  }
  return { targets, shared };
}

/** Runs in the page: the href of the first <link rel="alternate" type="text/markdown">, resolved. */
export function markdownAlternateInPage(): string | null {
  for (const l of Array.from(document.querySelectorAll("link[href]"))) {
    const rel = (l.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const type = (l.getAttribute("type") ?? "").toLowerCase();
    if (rel.includes("alternate") && /markdown/.test(type)) return (l as HTMLLinkElement).href;
  }
  return null;
}

type Requester = Pick<import("playwright").APIRequestContext, "get">;

export type MarkdownResult = {
  /** The alternate's absolute URL, or null when the page links none. */
  url: string | null;
  status: number | null;
  /** Bundle path of the saved Markdown, or null. */
  file: string | null;
  /** Why a linked alternate was not saved. */
  note: string | null;
};

const looksLikeHtml = (body: string, type: string) => /text\/html/i.test(type) || /^\s*<(!doctype|html)\b/i.test(body);

/** Fetch a page's Markdown alternate (same origin only) and save it at bundle path `file`. */
export async function saveMarkdownAlternate(href: string | null, base: URL, request: Requester, tmp: string, file: string, timeoutMs: number): Promise<MarkdownResult> {
  if (!href) return { url: null, status: null, file: null, note: null };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { url: href, status: null, file: null, note: "not a valid URL" };
  }
  if (url.origin !== base.origin) return { url: url.toString(), status: null, file: null, note: `not on the deployment's origin (${base.origin}); not fetched` };
  const resp = await request.get(url.toString(), { timeout: timeoutMs }).catch((e: Error) => e);
  if (resp instanceof Error) return { url: url.toString(), status: null, file: null, note: `fetch failed: ${resp.message.split("\n")[0]}` };
  const status = resp.status();
  if (status >= 400) return { url: url.toString(), status, file: null, note: `HTTP ${status}` };
  const body = await resp.body();
  const text = body.toString("utf8");
  if (looksLikeHtml(text, resp.headers()["content-type"] ?? "")) return { url: url.toString(), status, file: null, note: "returned HTML, not Markdown" };
  if (!text.trim()) return { url: url.toString(), status, file: null, note: "empty body" };
  await writeFile(join(tmp, file), body);
  return { url: url.toString(), status, file, note: null };
}

export type LlmsTxt = { url: string; status: number | null; file: string | null; note: string | null };

/** Save /llms.txt into docs/llms.txt when the deployment serves it as text. */
export async function saveLlmsTxt(base: URL, request: Requester, tmp: string, timeoutMs: number): Promise<LlmsTxt> {
  const url = new URL("/llms.txt", base).toString();
  const file = `${DOCS_DIR}/llms.txt`;
  const resp = await request.get(url, { timeout: timeoutMs }).catch((e: Error) => e);
  if (resp instanceof Error) return { url, status: null, file: null, note: `fetch failed: ${resp.message.split("\n")[0]}` };
  const status = resp.status();
  if (status >= 400) return { url, status, file: null, note: `HTTP ${status}` };
  const body = await resp.body();
  const text = body.toString("utf8");
  if (looksLikeHtml(text, resp.headers()["content-type"] ?? "")) return { url, status, file: null, note: "returned HTML, not text" };
  if (!text.trim()) return { url, status, file: null, note: "empty body" };
  await writeFile(join(tmp, file), body);
  return { url, status, file, note: null };
}
