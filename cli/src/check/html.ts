// Small, dependency-free HTML extraction for the deterministic gates.
// Static sites only: enough to read titles, headings, links, meta tags and code samples.

export type Attrs = Record<string, string>;

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function parseAttrs(src: string): Attrs {
  const out: Attrs = {};
  for (const m of src.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Remove comments, scripts, styles and templates: what is left is what a reader can see. */
export function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, "");
}

/** Every start tag `<name ...>` with its attributes (comments and scripts removed first). */
export function tags(html: string, name: string): Attrs[] {
  const re = new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi");
  return [...stripNonContent(html).matchAll(re)].map((m) => parseAttrs(m[1]));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Visible text: tags removed, entities decoded, whitespace collapsed. */
export function visibleText(html: string): string {
  return decodeEntities(stripNonContent(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function title(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(stripNonContent(html));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
}

export function htmlLang(html: string): string | null {
  const t = tags(html, "html")[0];
  return t?.lang?.trim() || null;
}

export function h1Count(html: string): number {
  return tags(html, "h1").length;
}

export function metaRobots(html: string): string[] {
  return tags(html, "meta")
    .filter((a) => (a.name ?? "").toLowerCase() === "robots")
    .map((a) => (a.content ?? "").toLowerCase());
}

/** URLs a page refers to: anchors, stylesheets and icons, scripts, images and media sources. */
export function references(html: string): { tag: string; url: string }[] {
  const out: { tag: string; url: string }[] = [];
  const add = (tag: string, attr: string) => {
    for (const a of tags(html, tag)) if (a[attr]) out.push({ tag, url: a[attr].trim() });
  };
  add("a", "href");
  add("link", "href");
  add("img", "src");
  add("source", "src");
  add("video", "src");
  add("audio", "src");
  add("iframe", "src");
  // Scripts are stripped by tags(); read their src from the raw HTML.
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const a = parseAttrs(m[1]);
    if (a.src) out.push({ tag: "script", url: a.src.trim() });
  }
  return out;
}

export interface CodeSample {
  op: string;
  /** True when the <code data-op> sits directly inside a <pre>, as the contract asks. */
  inPre: boolean;
}

/** Code samples that call the product: `<code data-op="operationId">`. */
export function codeSamples(html: string): CodeSample[] {
  const src = stripNonContent(html);
  const out: CodeSample[] = [];
  for (const m of src.matchAll(/(<pre\b[^>]*>\s*)?<code\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const a = parseAttrs(m[2]);
    if ("data-op" in a) out.push({ op: a["data-op"].trim(), inPre: Boolean(m[1]) });
  }
  return out;
}
