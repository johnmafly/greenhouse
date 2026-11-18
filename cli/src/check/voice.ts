// product-voice: the site reads as a shipping product. Fails on language that frames it as
// hypothetical, planned, proposed, a concept, a demo or "by design" (decision 0005), anywhere a
// person or an agent reading the site can meet it: rendered text and served source.
import type { Gate } from "../lib/schemas.ts";
import { jsImports, pageAssets } from "./assets.ts";
import { NOT_FOUND_PROBE, gate } from "./gates.ts";
import { parseAttrs, references, visibleText } from "./html.ts";
import { htmlPages, internalPath } from "./site.ts";
import type { Site } from "./site.ts";

/**
 * The banned list, case-insensitive, on word boundaries. Each entry names its explicit forms, and
 * the pattern matches exactly those forms. Word boundaries keep the list to what it names:
 * "concept" does not match "Concepts" (a docs section), "propos*" does not match "proposition",
 * "demo" does not match "demonstrate".
 */
export const VOICE_LIST: [string, string[]][] = [
  ["by design", ["by design"]],
  ["in design", ["in design"]],
  ["planned", ["planned"]],
  ["plan to", ["plan to", "plans to", "planning to"]],
  ["propos*", ["propose", "proposes", "proposed", "proposing", "proposal", "proposals"]],
  ["hypothetical", ["hypothetical", "hypothetically"]],
  ["concept", ["concept"]],
  ["demo", ["demo", "demos"]],
  ["mockup", ["mockup", "mockups", "mock-up", "mock-ups"]],
  ["prototype", ["prototype", "prototypes", "prototyped", "prototyping"]],
  ["roadmap", ["roadmap", "roadmaps", "road-map", "road-maps"]],
  ["coming soon", ["coming soon"]],
  ["not built", ["not built", "not yet built"]],
  ["not for sale", ["not for sale"]],
  ["nothing is for sale", ["nothing is for sale"]],
  ["for sale yet", ["for sale yet"]],
  ["illustrative", ["illustrative", "illustratively"]],
  ["not a real", ["not a real"]],
  ["first build", ["first build"]],
  ["come later", ["come later", "comes later"]],
  ["ships later", ["ship later", "ships later"]],
  ["architecture plan", ["architecture plan", "architecture plans"]],
  ["placeholder copy", ["placeholder copy"]],
];

const formRe = (forms: string[], flags = "i") =>
  new RegExp(`\\b(?:${[...forms].sort((a, b) => b.length - a.length).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})\\b`, flags);

export const VOICE_PATTERNS: [string, RegExp][] = VOICE_LIST.map(([label, forms]) => [label, formRe(forms)]);

export interface VoiceSource {
  /** Page path or served file the text came from. */
  source: string;
  /** Where in it: text, title, meta[description], img[alt], json-ld, js string, file. */
  where: string;
  text: string;
}

export interface VoiceHit {
  source: string;
  where: string;
  pattern: string;
  /** The form found, lowercased: "proposals", "mock-up", "planning to". */
  match: string;
  snippet: string;
}

const TEXT_ATTRS = ["alt", "title", "aria-label", "aria-description", "placeholder"];

/** Every piece of text a page carries that a person or an agent can read (HTML comments excluded). */
export function pageVoiceSources(html: string, source: string): VoiceSource[] {
  const out: VoiceSource[] = [];
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(noComments);
  if (t) out.push({ source, where: "title", text: visibleText(t[1]) });
  out.push({ source, where: "text", text: visibleText(noComments.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")) });
  for (const m of noComments.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = (parseAttrs(m[1]).type ?? "").toLowerCase();
    if (!m[2].trim()) continue;
    if (type === "application/ld+json") out.push({ source, where: "json-ld", text: m[2].replace(/\s+/g, " ").trim() });
    else if (type.includes("json")) out.push({ source, where: "inline json", text: m[2].replace(/\s+/g, " ").trim() });
    else for (const s of jsStrings(m[2])) out.push({ source, where: "inline js string", text: s });
  }
  const noScripts = noComments.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  for (const m of noScripts.matchAll(/<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[1].toLowerCase();
    const a = parseAttrs(m[2]);
    for (const k of TEXT_ATTRS) if (a[k]?.trim()) out.push({ source, where: `${tag}[${k}]`, text: a[k].trim() });
    if (tag === "meta" && a.content?.trim()) out.push({ source, where: `meta[${a.name ?? a.property ?? a["http-equiv"] ?? "content"}]`, text: a.content.trim() });
  }
  return out;
}

/**
 * String and template literals in JavaScript (comments skipped, regex literals stepped over).
 * Only strings with a letter in them are returned.
 */
export function jsStrings(js: string): string[] {
  const out: string[] = [];
  let i = 0;
  let prev = ""; // last significant code character, to tell a regex literal from division
  const n = js.length;
  while (i < n) {
    const c = js[i];
    if (c === "/" && js[i + 1] === "/") {
      const e = js.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && js[i + 1] === "*") {
      const e = js.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let s = "";
      while (j < n && js[j] !== c) {
        if (js[j] === "\\" && j + 1 < n) {
          s += js[j + 1] === "n" ? "\n" : js[j + 1];
          j += 2;
          continue;
        }
        if (c !== "`" && js[j] === "\n") break;
        s += js[j++];
      }
      if (/[a-z]/i.test(s)) out.push(s.replace(/\s+/g, " ").trim());
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && js[j] !== "\n") {
        if (js[j] === "\\") j++;
        else if (js[j] === "[") inClass = true;
        else if (js[j] === "]") inClass = false;
        else if (js[j] === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Banned-list hits in a set of sources: one per distinct form found per source text. */
export function voiceHits(sources: VoiceSource[]): VoiceHit[] {
  const hits: VoiceHit[] = [];
  for (const s of sources) {
    for (const [pattern, forms] of VOICE_LIST) {
      const seen = new Set<string>();
      for (const m of s.text.matchAll(formRe(forms, "gi"))) {
        const match = m[0].toLowerCase().replace(/\s+/g, " ");
        if (seen.has(match)) continue;
        seen.add(match);
        const at = m.index ?? 0;
        const snippet = s.text.slice(Math.max(0, at - 60), at + m[0].length + 60).replace(/\s+/g, " ").trim();
        hits.push({ source: s.source, where: s.where, pattern, match, snippet });
      }
    }
  }
  return hits;
}

type Fetcher = (url: string) => Promise<{ status: number; headers: Headers; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });

/** Agent-facing text files every site may serve; read when present. */
export const AGENT_FILES = ["/llms.txt", "/llms-full.txt"];
const TEXT_FILE_RE = /\.(txt|ya?ml|md)$/i;

export async function productVoiceGate(site: Site | null, why = "no site to check", fetcher: Fetcher = defaultFetch, maxFiles = 200): Promise<Gate> {
  const id = "product-voice";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  const pages = htmlPages(site);
  if (pages.length === 0) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const origin = new URL(site.base).origin;
  const sources: VoiceSource[] = [];
  const errors: string[] = [];
  const read = async (url: string): Promise<{ status: number; type: string; body: string } | null> => {
    try {
      const r = await fetcher(url);
      return { status: r.status, type: r.headers.get("content-type") ?? "", body: await r.text() };
    } catch (e) {
      errors.push(`${new URL(url).pathname}: ${(e as Error).message}`);
      return null;
    }
  };

  // Every crawled page, and the 404 page.
  const htmlDocs = pages.map((p) => ({ path: p.path, url: p.url, body: p.body }));
  const nf = await read(new URL(NOT_FOUND_PROBE, site.base).toString());
  if (nf && /text\/html/i.test(nf.type)) htmlDocs.push({ path: "404 page", url: new URL(NOT_FOUND_PROBE, site.base).toString(), body: nf.body });
  for (const d of htmlDocs) sources.push(...pageVoiceSources(d.body, d.path));

  // Served JavaScript (following imports) and text files the pages link to, plus llms.txt.
  const scripts: string[] = [];
  const files = new Set<string>(AGENT_FILES.map((p) => new URL(p, site.base).toString()));
  for (const d of htmlDocs) {
    for (const a of pageAssets(d.body, d.url, origin, d.path)) if (a.kind === "script" || a.kind === "module") scripts.push(a.url);
    for (const r of references(d.body)) {
      const p = internalPath(r.url, d.url, site.base);
      if (p && TEXT_FILE_RE.test(p.split("?")[0])) files.add(new URL(p, site.base).toString());
    }
  }
  const seenJs = new Set<string>();
  let jsCount = 0;
  while (scripts.length && seenJs.size < maxFiles) {
    const url = scripts.shift() as string;
    if (seenJs.has(url)) continue;
    seenJs.add(url);
    const r = await read(url);
    if (!r || r.status >= 400) continue;
    jsCount++;
    const path = new URL(url).pathname;
    for (const s of jsStrings(r.body)) sources.push({ source: path, where: "js string", text: s });
    for (const imp of jsImports(r.body, url, origin)) if (!seenJs.has(imp.url)) scripts.push(imp.url);
  }
  let fileCount = 0;
  for (const url of [...files].slice(0, maxFiles)) {
    const r = await read(url);
    if (!r || r.status >= 400 || /text\/html/i.test(r.type)) continue; // an SPA fallback is not the file
    fileCount++;
    sources.push({ source: new URL(url).pathname, where: "file", text: r.body });
  }

  const hits = voiceHits(sources);
  const metrics = { pages: htmlDocs.length, scripts: jsCount, files: fileCount, hits: hits.length };
  const details: Record<string, unknown> = { hits: hits.slice(0, 100) };
  if (errors.length) details.errors = errors.slice(0, 20);
  if (hits.length) {
    const where = new Set(hits.map((h) => h.source));
    const words = [...new Set(hits.map((h) => h.match))].slice(0, 8).join(", ");
    return gate(id, "fail", `${hits.length} hedged or hypothetical phrase${hits.length === 1 ? "" : "s"} (${words}) in ${where.size} page${where.size === 1 ? "" : "s"} or file${where.size === 1 ? "" : "s"}`, metrics, details);
  }
  return gate(id, "pass", `no hedged or hypothetical framing in ${htmlDocs.length} pages, ${jsCount} scripts and ${fileCount} text files`, metrics, errors.length ? details : undefined);
}
