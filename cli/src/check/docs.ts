// docs: every Greenhouse project ships a comprehensive user guide (decision 0006). greenhouse.yaml
// declares where each required section lives in a `docs:` block (section key -> site path, or a
// list of paths, each with an optional #anchor). The gate fails when a section is missing or thin,
// when the architecture section has no diagram, when the API reference does not cover every
// operation in spec/openapi.yaml, when a docs page has no Markdown version, or when /llms.txt and
// /llms-full.txt are missing or do not list the docs pages. Headings without ids only warn.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Gate } from "../lib/schemas.ts";
import { parseContentRef } from "./content.ts";
import type { ContentKey } from "./content.ts";
import { gate } from "./gates.ts";
import { parseAttrs, stripNonContent, visibleText } from "./html.ts";
import { elementById } from "./text.ts";
import { internalPath } from "./site.ts";
import type { Site } from "./site.ts";

/** The required sections, in guide order, with what each covers and its word floor. */
export const DOCS_SECTIONS: { key: string; name: string; minWords: number }[] = [
  { key: "overview", name: "Overview and concepts", minWords: 150 },
  { key: "architecture", name: "Design and architecture (with diagrams)", minWords: 150 },
  { key: "features", name: "Features", minWords: 150 },
  { key: "quickstart", name: "Install and quickstart", minWords: 150 },
  { key: "configuration", name: "Configuration", minWords: 150 },
  { key: "integrations", name: "Integrations", minWords: 150 },
  { key: "api_reference", name: "API reference", minWords: 150 },
  { key: "sdk_reference", name: "SDK reference", minWords: 150 },
  { key: "domain_reference", name: "Domain reference", minWords: 150 },
  { key: "self_hosting", name: "Self-hosting and operations", minWords: 150 },
  { key: "security", name: "Security model", minWords: 150 },
  { key: "faq", name: "FAQ", minWords: 100 },
  { key: "changelog", name: "Changelog", minWords: 40 },
];
export const DOCS_KEYS = DOCS_SECTIONS.map((s) => s.key);

export interface DocsRef {
  key: string;
  path: string;
  anchor: string | null;
  raw: string;
}

export interface DocsMap {
  present: boolean;
  /** Valid refs by section key (a key may list several pages). */
  sections: Map<string, DocsRef[]>;
  errors: string[];
}

/** Parse the `docs:` block of greenhouse.yaml. */
export function parseDocsMap(doc: unknown): DocsMap {
  const sections = new Map<string, DocsRef[]>();
  const docs = doc && typeof doc === "object" ? (doc as Record<string, unknown>).docs : undefined;
  if (docs === undefined || docs === null) return { present: false, sections, errors: [] };
  if (typeof docs !== "object" || Array.isArray(docs))
    return { present: true, sections, errors: ["greenhouse.yaml: docs must be a mapping of the required sections to site paths"] };
  const map = docs as Record<string, unknown>;
  const errors: string[] = [];
  for (const { key } of DOCS_SECTIONS) {
    if (!(key in map)) {
      errors.push(`greenhouse.yaml: docs.${key} is missing`);
      continue;
    }
    const values = Array.isArray(map[key]) ? (map[key] as unknown[]) : [map[key]];
    if (values.length === 0) errors.push(`greenhouse.yaml: docs.${key} is an empty list`);
    const refs: DocsRef[] = [];
    for (const v of values) {
      // Same path rules as the content map.
      const r = parseContentRef(key as ContentKey, v);
      if (r.ref) refs.push({ key, path: r.ref.path, anchor: r.ref.anchor, raw: r.ref.raw });
      else errors.push(`greenhouse.yaml: ${(r.error ?? "").replace(/^content\./, "docs.")}`);
    }
    if (refs.length) sections.set(key, refs);
  }
  for (const key of Object.keys(map)) if (!DOCS_KEYS.includes(key)) errors.push(`greenhouse.yaml: docs.${key} is not a known section (${DOCS_KEYS.join(", ")})`);
  return { present: true, sections, errors };
}

export function readDocsMap(dir: string | null): DocsMap {
  const empty: DocsMap = { present: false, sections: new Map(), errors: [] };
  if (!dir) return empty;
  const file = join(dir, "greenhouse.yaml");
  if (!existsSync(file)) return empty;
  try {
    return parseDocsMap(parseYaml(readFileSync(file, "utf8")));
  } catch {
    return empty; // package-files reports a greenhouse.yaml that does not parse
  }
}

/** "METHOD /path" and operationId for every operation in spec/openapi.yaml, or null without one. */
export function openApiOperations(dir: string | null): { method: string; path: string; operationId: string | null }[] | null {
  if (!dir) return null;
  const file = join(dir, "spec", "openapi.yaml");
  if (!existsSync(file)) return null;
  let doc: any;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch {
    return null; // package-files reports it
  }
  if (!doc || typeof doc.paths !== "object" || doc.paths === null) return null;
  const out: { method: string; path: string; operationId: string | null }[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    if (!item || typeof item !== "object") continue;
    for (const m of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      if (item[m] && typeof item[m] === "object") out.push({ method: m.toUpperCase(), path, operationId: typeof item[m].operationId === "string" ? item[m].operationId : null });
    }
  }
  return out;
}

/** The guide content of a page: <main> (else <body>) without nav, header, footer and aside. */
export function docsContent(html: string): string {
  const src = stripNonContent(html);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(src)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(src)?.[1] ?? src;
  return main.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_.-]*/gu) ?? []).length;
}

const DIAGRAM_RE = /<(svg|img|picture|object|canvas)\b|<[a-z]+\b[^>]*\brole\s*=\s*["']?img\b|<pre\b[^>]*\bclass\s*=\s*["'][^"']*\bmermaid\b/i;

/** Headings (h2, h3) without an id: no stable anchor to link to. */
export function headingsWithoutIds(html: string): string[] {
  const out: string[] = [];
  for (const m of docsContent(html).matchAll(/<h([23])\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/h\1\s*>/gi)) {
    const a = parseAttrs(m[2]);
    // An id on the heading, or a self-link anchor inside it (<h2><a id="x" href="#x">).
    if (a.id || /<a\b[^>]*\b(id|name)\s*=/i.test(m[3])) continue;
    out.push(`h${m[1]} ${visibleText(m[3]).slice(0, 80)}`);
  }
  return out;
}

/** Candidate Markdown URLs for a docs page path: /docs/api/ -> /docs/api/index.md, /docs/api.md. */
export function markdownCandidates(path: string): string[] {
  if (path.endsWith("/")) return path === "/" ? ["/index.md"] : [`${path}index.md`, `${path.slice(0, -1)}.md`];
  if (/\.html?$/i.test(path)) return [path.replace(/\.html?$/i, ".md")];
  return [`${path}.md`, `${path}/index.md`];
}

type Fetcher = (url: string) => Promise<{ status: number; headers: Headers; text(): Promise<string>; url?: string }>;
const defaultFetch: Fetcher = (url) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });

interface Fetched {
  status: number;
  type: string;
  body: string;
  url: string;
}

const isMarkupBody = (f: Fetched) => /text\/html/i.test(f.type) || /^\s*<(!doctype|html)\b/i.test(f.body);

export interface DocsOptions {
  fetcher?: Fetcher;
}

export async function docsGate(site: Site | null, dir: string | null, why = "no site to check", opts: DocsOptions = {}): Promise<Gate> {
  const id = "docs";
  if (!dir) return gate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  const map = readDocsMap(dir);
  if (!map.present)
    return gate(id, "fail", "greenhouse.yaml has no docs: block, so the user guide's sections cannot be found (decision 0006)", { sections: 0 }, {
      problems: [`add docs: to greenhouse.yaml mapping each required section to its page: ${DOCS_KEYS.join(", ")}`],
    });
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  const fetcher = opts.fetcher ?? defaultFetch;
  const problems: string[] = [...map.errors];
  const warnings: string[] = [];
  const cache = new Map<string, Fetched | null>();
  const get = async (path: string): Promise<Fetched | null> => {
    const url = new URL(path, site.base).toString();
    if (cache.has(url)) return cache.get(url) ?? null;
    let out: Fetched | null = null;
    const crawled = site.pages.get(path);
    if (crawled) out = { status: crawled.status, type: crawled.contentType, body: crawled.body, url: crawled.url };
    else {
      try {
        const r = await fetcher(url);
        out = { status: r.status, type: r.headers.get("content-type") ?? "", body: await r.text(), url: r.url || url };
      } catch (e) {
        problems.push(`${path}: cannot fetch (${(e as Error).message})`);
      }
    }
    cache.set(url, out);
    return out;
  };

  // Each section: its pages load, anchors exist, enough words, and the architecture has a diagram.
  const pages = new Map<string, Fetched>(); // docs page path -> HTML
  const sectionReport: Record<string, unknown>[] = [];
  for (const s of DOCS_SECTIONS) {
    const refs = map.sections.get(s.key);
    if (!refs) continue; // already a problem from the map
    let words = 0;
    let fragments = "";
    let ok = true;
    for (const ref of refs) {
      const p = await get(ref.path);
      if (!p) {
        ok = false;
        continue;
      }
      if (p.status >= 400 || !/text\/html/i.test(p.type)) {
        problems.push(`docs.${s.key}: ${ref.path} returns ${p.status} ${p.type.split(";")[0] || "(no content type)"}, not an HTML page`);
        ok = false;
        continue;
      }
      pages.set(ref.path, p);
      let html = docsContent(p.body);
      if (ref.anchor) {
        const el = elementById(stripNonContent(p.body), ref.anchor);
        if (!el) {
          problems.push(`docs.${s.key}: ${ref.raw} has no element with id "${ref.anchor}"`);
          ok = false;
          continue;
        }
        html = el;
      }
      fragments += ` ${html}`;
      words += wordCount(visibleText(html));
    }
    const entry: Record<string, unknown> = { section: s.key, paths: refs.map((r) => r.raw), words };
    if (ok && words < s.minWords) problems.push(`docs.${s.key} (${s.name}): ${words} words, under the ${s.minWords}-word floor`);
    if (ok && s.key === "architecture" && !DIAGRAM_RE.test(fragments)) problems.push(`docs.architecture: no diagram (an <svg>, <img>, <picture>, <object> or role="img" element) in ${refs.map((r) => r.raw).join(", ")}`);
    sectionReport.push(entry);
  }

  // API reference covers every operation in spec/openapi.yaml.
  const ops = openApiOperations(dir);
  let opsMissing: string[] = [];
  if (ops && ops.length) {
    const refs = map.sections.get("api_reference");
    if (refs) {
      let text = "";
      for (const ref of refs) {
        const p = pages.get(ref.path);
        if (!p) continue;
        const html = ref.anchor ? (elementById(stripNonContent(p.body), ref.anchor) ?? "") : docsContent(p.body);
        text += ` ${visibleText(html)}`;
      }
      const norm = text.replace(/\s+/g, " ");
      opsMissing = ops
        .filter((o) => {
          if (o.operationId && new RegExp(`\\b${o.operationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(norm)) return false;
          return !norm.includes(o.path);
        })
        .map((o) => `${o.method} ${o.path}${o.operationId ? ` (${o.operationId})` : ""}`);
      if (opsMissing.length)
        problems.push(`docs.api_reference: ${opsMissing.length} of ${ops.length} operations in spec/openapi.yaml are not documented: ${opsMissing.slice(0, 10).join(", ")}${opsMissing.length > 10 ? ", …" : ""}`);
    }
  }

  // A Markdown version of every docs page.
  const markdown: Record<string, string> = {};
  for (const [path, p] of pages) {
    const cands: string[] = [];
    for (const m of p.body.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      const a = parseAttrs(m[1]);
      if (/\balternate\b/i.test(a.rel ?? "") && /markdown/i.test(a.type ?? "") && a.href) {
        const ip = internalPath(a.href, p.url, site.base);
        if (ip) cands.push(ip);
      }
    }
    cands.push(...markdownCandidates(path));
    let found: string | null = null;
    for (const c of [...new Set(cands)]) {
      const md = await get(c);
      if (md && md.status < 400 && !isMarkupBody(md) && wordCount(md.body) >= 20) {
        found = c;
        break;
      }
    }
    if (found) markdown[path] = found;
    else problems.push(`${path}: no Markdown version (tried ${[...new Set(cands)].join(", ")})`);
  }

  // /llms.txt indexes every docs page; /llms-full.txt carries every page.
  const base = new URL(site.base);
  const mentions = (body: string, path: string, h1: string | null): boolean => {
    const forms = [path, new URL(path, base).toString(), path.replace(/\/$/, "")].filter((f) => f && f !== "/");
    if (markdown[path]) forms.push(markdown[path], new URL(markdown[path], base).toString());
    if (path === "/") forms.push(base.toString());
    if (forms.some((f) => body.includes(f))) return true;
    // The page's own title as a Markdown heading (llms-full.txt carries the whole page).
    if (h1 === null || h1.length < 3) return false;
    return new RegExp(`^#{1,2}\\s+${h1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\s*(\\{#[^}]*\\})?\\s*$`, "im").test(body);
  };
  const h1Of = (html: string) => {
    const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(stripNonContent(html));
    return m ? visibleText(m[1]) : null;
  };
  const agentFiles: Record<string, unknown> = {};
  for (const [file, useTitle] of [["/llms.txt", false], ["/llms-full.txt", true]] as const) {
    const f = await get(file);
    if (!f || f.status >= 400 || isMarkupBody(f) || !f.body.trim()) {
      problems.push(`${file} is missing (${f ? `${f.status}${isMarkupBody(f) ? ", HTML" : ""}` : "not fetched"})`);
      agentFiles[file] = "missing";
      continue;
    }
    const missing = [...pages.entries()].filter(([path, p]) => !mentions(f.body, path, useTitle ? h1Of(p.body) : null)).map(([path]) => path);
    agentFiles[file] = { words: wordCount(f.body), missing_pages: missing };
    if (missing.length) problems.push(`${file} does not list ${missing.length} docs page${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 10).join(", ")}`);
  }

  // Stable anchors: headings carry ids.
  for (const [path, p] of pages) {
    const bare = headingsWithoutIds(p.body);
    if (bare.length) warnings.push(`${path}: ${bare.length} heading${bare.length === 1 ? "" : "s"} without an id (${bare.slice(0, 3).join("; ")})`);
  }

  const metrics = { sections: map.sections.size, pages: pages.size, markdown: Object.keys(markdown).length, operations: ops?.length ?? 0, operations_missing: opsMissing.length, problems: problems.length };
  const details: Record<string, unknown> = { sections: sectionReport, markdown, agent_files: agentFiles };
  if (problems.length) details.problems = problems.slice(0, 50);
  if (warnings.length) details.warnings = warnings.slice(0, 50);
  if (problems.length) return gate(id, "fail", `${problems.length} user-guide problem${problems.length === 1 ? "" : "s"}: ${problems[0]}`, metrics, details);
  const summary = `user guide: ${DOCS_SECTIONS.length} sections on ${pages.size} pages, each with a Markdown version, listed in /llms.txt and /llms-full.txt${ops?.length ? `; the API reference covers all ${ops.length} operations` : ""}`;
  if (warnings.length) return gate(id, "warn", `${summary}; ${warnings.length} page${warnings.length === 1 ? " has" : "s have"} headings without stable ids`, metrics, details);
  return gate(id, "pass", summary, metrics, details);
}
