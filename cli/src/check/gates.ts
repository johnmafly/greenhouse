// Deterministic gates that need no browser. Each returns one Gate for checks.json.
// A gate that cannot run returns `fail` with the reason, never a silent `pass`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Gate, GateStatus } from "../lib/schemas.ts";
import { validate } from "../lib/schemas.ts";
import { parseContentMap } from "./content.ts";
import type { ContentMap } from "./content.ts";
import { codeSamples, fragmentIds, h1Count, htmlLang, metaRobots, references, title, visibleText } from "./html.ts";
import { DOCS_SECTIONS, REQUIRED_ROUTES, fetchPage, htmlPages, internalPath } from "./site.ts";
import type { Site } from "./site.ts";

export function gate(id: string, status: GateStatus, summary: string, metrics?: Gate["metrics"], details?: unknown): Gate {
  const g: Gate = { id, class: "deterministic", status, summary };
  if (metrics !== undefined) g.metrics = metrics;
  if (details !== undefined) g.details = details;
  return g;
}

/**
 * A gate that threw instead of returning a result (a browser that went away, a protocol error):
 * recorded as a failed gate so the run still writes checks.json with every other gate.
 */
export function gateError(id: string, e: unknown, cls: Gate["class"] = "deterministic"): Gate {
  const message = e instanceof Error ? e.message : String(e);
  const g = gate(id, "fail", `gate error: ${message.split("\n")[0].slice(0, 300)}`, undefined, { error: message.slice(0, 2000) });
  g.class = cls;
  return g;
}

/** Cap a list in details so checks.json stays readable. */
function first<T>(items: T[], n = 50): T[] {
  return items.slice(0, n);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------------------------
// Package manifest and repository files

export interface Manifest {
  slug: string;
  build: { command: string; output: string };
  production_branch: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const NO_CONTENT: ContentMap = { present: false, refs: [], errors: [] };

/**
 * greenhouse.yaml: the build fields (errors make `manifest` null) and, separately, the v2
 * `content` map (its problems are in `content.errors` and do not stop the build).
 */
export function readManifest(dir: string): { manifest: Manifest | null; errors: string[]; content: ContentMap } {
  const file = join(dir, "greenhouse.yaml");
  if (!existsSync(file)) return { manifest: null, errors: ["greenhouse.yaml is missing"], content: NO_CONTENT };
  let doc: any;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return { manifest: null, errors: [`greenhouse.yaml does not parse: ${(e as Error).message.split("\n")[0]}`], content: NO_CONTENT };
  }
  const errors: string[] = [];
  if (!doc || typeof doc !== "object") return { manifest: null, errors: ["greenhouse.yaml is not a mapping"], content: NO_CONTENT };
  const content = parseContentMap(doc);
  if (typeof doc.slug !== "string" || !SLUG_RE.test(doc.slug)) errors.push("greenhouse.yaml: slug must match ^[a-z0-9][a-z0-9-]{0,62}$");
  if (typeof doc.build?.command !== "string" || !doc.build.command.trim()) errors.push("greenhouse.yaml: build.command is required");
  if (typeof doc.build?.output !== "string" || !doc.build.output.trim()) errors.push("greenhouse.yaml: build.output is required");
  else if (doc.build.output.startsWith("/") || doc.build.output.split(/[\\/]/).includes("..")) errors.push("greenhouse.yaml: build.output must be a path inside the repo");
  if (doc.production_branch !== "main") errors.push("greenhouse.yaml: production_branch must be main");
  if (errors.length) return { manifest: null, errors, content };
  return { manifest: { slug: doc.slug, build: { command: doc.build.command, output: doc.build.output }, production_branch: "main" }, errors, content };
}

export function packageFilesGate(dir: string | null): Gate {
  const id = "package-files";
  if (!dir) return gate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  const m = readManifest(dir);
  const problems: string[] = [...m.errors, ...m.content.errors];
  const nonEmpty = (rel: string) => existsSync(join(dir, rel)) && statSync(join(dir, rel)).isFile() && readFileSync(join(dir, rel), "utf8").trim().length > 0;
  if (!nonEmpty("STATE.md")) problems.push("STATE.md is missing or empty");
  if (!existsSync(join(dir, "claims.yaml"))) problems.push("claims.yaml is missing");
  else {
    try {
      const r = validate("claims", parseYaml(readFileSync(join(dir, "claims.yaml"), "utf8")));
      for (const e of r.errors) problems.push(`claims.yaml ${e}`);
    } catch (e) {
      problems.push(`claims.yaml does not parse: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const spec = loadSpecOps(dir);
  if (spec.error) problems.push(spec.error);
  const metrics = { problems: problems.length, content_map: m.content.present };
  if (problems.length) return gate(id, "fail", `${plural(problems.length, "problem")} in the package files`, metrics, { problems });
  if (!m.content.present)
    return gate(id, "warn", `package files are valid, but greenhouse.yaml has no content map (contract v2): the check falls back to the v1 route list`, metrics, {
      fallback: "no `content` in greenhouse.yaml; routes, crawl, no-js-content, signup and lighthouse use the v1 routes",
    });
  return gate(id, "pass", `greenhouse.yaml (with its content map), STATE.md, claims.yaml and ${spec.file} are present and valid`, metrics, {
    content: Object.fromEntries(m.content.refs.map((r) => [r.key, r.raw])),
  });
}

/** operationIds from spec/openapi.yaml, or from `operationId: x` lines in spec/interface.md. */
export function loadSpecOps(dir: string): { file: string; ops: Set<string>; error?: string } {
  const openapi = join(dir, "spec", "openapi.yaml");
  const iface = join(dir, "spec", "interface.md");
  if (existsSync(openapi)) {
    let doc: any;
    try {
      doc = parseYaml(readFileSync(openapi, "utf8"));
    } catch (e) {
      return { file: "spec/openapi.yaml", ops: new Set(), error: `spec/openapi.yaml does not parse: ${(e as Error).message.split("\n")[0]}` };
    }
    if (!doc || typeof doc.openapi !== "string" || typeof doc.paths !== "object" || doc.paths === null)
      return { file: "spec/openapi.yaml", ops: new Set(), error: "spec/openapi.yaml needs an `openapi` version and a `paths` mapping" };
    const ops = new Set<string>();
    for (const item of Object.values<any>(doc.paths)) {
      if (!item || typeof item !== "object") continue;
      for (const m of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
        if (typeof item[m]?.operationId === "string") ops.add(item[m].operationId);
      }
    }
    for (const item of Object.values<any>(doc.webhooks ?? {})) {
      for (const op of Object.values<any>(item ?? {})) if (typeof op?.operationId === "string") ops.add(op.operationId);
    }
    return { file: "spec/openapi.yaml", ops };
  }
  if (existsSync(iface)) {
    const ops = new Set<string>();
    for (const m of readFileSync(iface, "utf8").matchAll(/operationId:\s*`?([A-Za-z0-9_.-]+)`?/g)) ops.add(m[1]);
    return { file: "spec/interface.md", ops };
  }
  return { file: "spec/openapi.yaml", ops: new Set(), error: "spec/openapi.yaml (or spec/interface.md) is missing" };
}

// ---------------------------------------------------------------------------------------------
// Deployment

export async function deployedShaGate(base: string | null, expectedSha: string, expectedSlug: string | null, why = "no site to check"): Promise<Gate> {
  const id = "deployed-sha";
  if (!base) return gate(id, "fail", `cannot run: ${why}`);
  let page;
  try {
    page = await fetchPage(base, ".well-known/greenhouse.json");
  } catch (e) {
    return gate(id, "fail", `cannot fetch /.well-known/greenhouse.json: ${(e as Error).message}`);
  }
  if (page.status !== 200) return gate(id, "fail", `/.well-known/greenhouse.json returned HTTP ${page.status}`, { http_status: page.status });
  let info: any;
  try {
    info = JSON.parse(page.body);
  } catch {
    return gate(id, "fail", "/.well-known/greenhouse.json is not JSON");
  }
  const problems: string[] = [];
  if (info?.sha !== expectedSha) problems.push(`deployed sha ${String(info?.sha)} != expected ${expectedSha}`);
  if (expectedSlug && info?.slug !== expectedSlug) problems.push(`deployed slug ${JSON.stringify(info?.slug)} != greenhouse.yaml slug ${JSON.stringify(expectedSlug)}`);
  if (typeof info?.built_at !== "string" || Number.isNaN(Date.parse(info.built_at))) problems.push("built_at is missing or not ISO 8601");
  const metrics = { deployed_sha: typeof info?.sha === "string" ? info.sha : null, built_at: typeof info?.built_at === "string" ? info.built_at : null };
  return problems.length
    ? gate(id, "fail", problems.join("; "), metrics)
    : gate(id, "pass", `deployment reports ${expectedSha.slice(0, 12)} (slug ${info.slug})`, metrics);
}

// ---------------------------------------------------------------------------------------------
// Site content

function noSite(id: string, why: string): Gate {
  return gate(id, "fail", `cannot run: ${why}`);
}

/** Path that should not exist on any site, for the 404 check. */
export const NOT_FOUND_PROBE = "/greenhouse-check-404-probe/";

function routeProblem(site: Site, r: string): string | null {
  const p = site.pages.get(r);
  const err = site.errors.find((e) => e.path === r);
  if (err) return `${r}: ${err.error}`;
  if (!p) return `${r}: not fetched`;
  if (p.status !== 200) return `${r}: HTTP ${p.status}`;
  if (!p.isHtml) return `${r}: not HTML (${p.contentType || "no content-type"})`;
  return null;
}

async function notFoundProblem(site: Site): Promise<string | null> {
  try {
    const p = await fetchPage(site.base, NOT_FOUND_PROBE);
    if (p.status !== 404) return `404 page: ${NOT_FOUND_PROBE} returned HTTP ${p.status}, not 404`;
    if (!p.isHtml || !visibleText(p.body)) return `404 page: ${NOT_FOUND_PROBE} returned 404 without an HTML page`;
    return null;
  } catch (e) {
    return `404 page: ${(e as Error).message}`;
  }
}

/**
 * Contract v2 (content map present): `/` and every content path return HTML with HTTP 200, every
 * #anchor exists on its page, and unknown paths get an HTML 404 page. Without a content map:
 * the v1 route list and the /docs/ section links, reported as `warn` (fallback).
 */
export async function routesGate(site: Site | null, content: ContentMap | null, why = "no site to check"): Promise<Gate> {
  const id = "routes";
  if (!site) return noSite(id, why);
  const problems: string[] = [];
  const nf = await notFoundProblem(site);
  if (content?.present) {
    const p = routeProblem(site, "/");
    if (p) problems.push(p);
    for (const e of content.errors) problems.push(`${e} (see package-files)`);
    const checked = new Set<string>(["/"]);
    for (const ref of content.refs) {
      if (!checked.has(ref.path)) {
        checked.add(ref.path);
        const rp = routeProblem(site, ref.path);
        if (rp) problems.push(`content.${ref.key} ${rp}`);
      }
      const page = site.pages.get(ref.path);
      if (ref.anchor && page && page.status === 200 && page.isHtml && !fragmentIds(page.body).has(ref.anchor))
        problems.push(`content.${ref.key}: ${ref.path} has no element with id "${ref.anchor}"`);
    }
    if (nf) problems.push(nf);
    const metrics = { content_paths: checked.size, anchors: content.refs.filter((r) => r.anchor).length, problems: problems.length, fallback: false };
    const map = Object.fromEntries(content.refs.map((r) => [r.key, r.raw]));
    return problems.length
      ? gate(id, "fail", plural(problems.length, "route problem"), metrics, { problems, content: map })
      : gate(id, "pass", `/ and ${plural(checked.size - 1, "content path")} return HTML, ${plural(metrics.anchors, "anchor")} found, unknown paths get a 404 page`, metrics, { content: map });
  }
  for (const r of REQUIRED_ROUTES) {
    const p = routeProblem(site, r);
    if (p) problems.push(p);
  }
  const docs = site.pages.get("/docs/");
  if (docs && docs.status === 200 && docs.isHtml) {
    const linked = new Set(
      references(docs.body)
        .filter((r) => r.tag === "a")
        .map((r) => internalPath(r.url, docs.url, site.base)?.split(/[?#]/)[0])
        .filter(Boolean)
        .map((p) => (p as string).replace(/\/?$/, "/")),
    );
    for (const s of DOCS_SECTIONS) if (!linked.has(s)) problems.push(`/docs/ does not link to ${s}`);
  }
  if (nf) problems.push(nf);
  const metrics = { required: REQUIRED_ROUTES.length, problems: problems.length, fallback: true };
  const fallback = "greenhouse.yaml has no content map (contract v2): checked the v1 route list instead";
  return problems.length
    ? gate(id, "fail", `${plural(problems.length, "route problem")} (v1 route list: no content map)`, metrics, { problems, fallback })
    : gate(id, "warn", `all ${REQUIRED_ROUTES.length} v1 routes return HTML and /docs/ links the five sections, but greenhouse.yaml has no content map (fallback)`, metrics, { fallback });
}

export async function linksGate(site: Site | null, why = "no site to check"): Promise<Gate> {
  const id = "links";
  if (!site) return noSite(id, why);
  const targets = new Map<string, Set<string>>(); // path -> pages that link to it
  const ignored = new Set<string>();
  for (const p of htmlPages(site)) {
    for (const ref of references(p.body)) {
      const target = internalPath(ref.url, p.url, site.base);
      if (!target) continue;
      // Cloudflare rewrites served HTML under /cdn-cgi/ (email obfuscation turns mailto: links into
      // /cdn-cgi/l/email-protection#…, and injects its own scripts): the host's URLs, not the package's.
      if (/^\/cdn-cgi\//.test(target)) {
        ignored.add(target.split("#")[0]);
        continue;
      }
      if (!targets.has(target)) targets.set(target, new Set());
      (targets.get(target) as Set<string>).add(p.path);
    }
  }
  const broken: { url: string; status: number | string; from: string[] }[] = [];
  for (const [target, from] of [...targets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const known = site.pages.get(target);
    let status: number | string;
    if (known) status = known.status;
    else {
      try {
        status = (await fetchPage(site.base, target)).status;
      } catch (e) {
        status = (e as Error).message;
      }
    }
    if (typeof status === "string" || status >= 400) broken.push({ url: target, status, from: [...from].sort() });
  }
  const metrics = { pages: htmlPages(site).length, internal_urls: targets.size, broken: broken.length };
  const extra = ignored.size ? { ignored_host_rewrites: [...ignored].sort().slice(0, 20) } : {};
  return broken.length
    ? gate(id, "fail", `${plural(broken.length, "broken internal link")}`, metrics, { broken: first(broken), ...extra })
    : gate(id, "pass", `${targets.size} internal URLs on ${metrics.pages} pages all resolve`, metrics, ignored.size ? extra : undefined);
}

export function pageStructureGate(site: Site | null, why = "no site to check"): Gate {
  const id = "page-structure";
  if (!site) return noSite(id, why);
  const pages = htmlPages(site);
  if (pages.length === 0) return gate(id, "fail", "no HTML pages loaded");
  const problems: string[] = [];
  for (const p of pages) {
    if (!htmlLang(p.body)) problems.push(`${p.path}: <html> has no lang`);
    if (!title(p.body)) problems.push(`${p.path}: missing or empty <title>`);
    const n = h1Count(p.body);
    if (n !== 1) problems.push(`${p.path}: ${n} <h1> elements (need exactly one)`);
  }
  return problems.length
    ? gate(id, "fail", `${plural(problems.length, "problem")} on ${pages.length} pages`, { pages: pages.length, problems: problems.length }, { problems: first(problems) })
    : gate(id, "pass", `${pages.length} pages each have lang, a title and one h1`, { pages: pages.length });
}

/**
 * Placeholder text from the contract (lorem, TODO, TBD, [placeholder]) plus unfinished-page
 * phrases ("coming soon", "coming in package v1").
 */
export const PLACEHOLDER_PATTERNS: [string, RegExp][] = [
  ["lorem", /\blorem\b/i],
  ["TODO", /\bTODO\b/],
  ["TBD", /\bTBD\b/],
  ["[placeholder]", /\[placeholder\]/i],
  ["coming soon", /\bcoming soon\b/i],
  ["coming in package", /\bcoming in package v\d/i],
];

export function placeholderGate(site: Site | null, why = "no site to check"): Gate {
  const id = "placeholder";
  if (!site) return noSite(id, why);
  const pages = htmlPages(site);
  if (pages.length === 0) return gate(id, "fail", "no HTML pages loaded");
  const hits: { page: string; pattern: string; excerpt: string }[] = [];
  for (const p of pages) {
    const text = `${title(p.body) ?? ""} ${visibleText(p.body)}`;
    for (const [name, re] of PLACEHOLDER_PATTERNS) {
      const m = re.exec(text);
      if (m) hits.push({ page: p.path, pattern: name, excerpt: text.slice(Math.max(0, m.index - 40), m.index + 60).trim() });
    }
  }
  return hits.length
    ? gate(id, "fail", `placeholder text on ${plural(new Set(hits.map((h) => h.page)).size, "page")}`, { pages: pages.length, hits: hits.length }, { hits: first(hits) })
    : gate(id, "pass", `no placeholder text on ${pages.length} pages`, { pages: pages.length });
}

export function noindexGate(site: Site | null, why = "no site to check"): Gate {
  const id = "noindex";
  if (!site) return noSite(id, why);
  const pages = htmlPages(site);
  if (pages.length === 0) return gate(id, "fail", "no HTML pages loaded");
  const problems: string[] = [];
  for (const p of pages) {
    if (!/noindex/i.test(p.headers["x-robots-tag"] ?? "")) problems.push(`${p.path}: no X-Robots-Tag: noindex header`);
    if (!metaRobots(p.body).some((c) => c.includes("noindex"))) problems.push(`${p.path}: no <meta name="robots" content="noindex">`);
  }
  return problems.length
    ? gate(id, "fail", `${plural(problems.length, "noindex problem")} on ${pages.length} pages`, { pages: pages.length, problems: problems.length }, { problems: first(problems) })
    : gate(id, "pass", `${pages.length} pages send X-Robots-Tag noindex and carry the robots meta tag`, { pages: pages.length });
}

export function specSamplesGate(dir: string | null, site: Site | null, why = "no site to check"): Gate {
  const id = "spec-samples";
  if (!dir) return gate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  if (!site) return noSite(id, why);
  const spec = loadSpecOps(dir);
  if (spec.error) return gate(id, "fail", `cannot run: ${spec.error}`);
  const samples: { page: string; op: string; inPre: boolean }[] = [];
  for (const p of htmlPages(site)) for (const s of codeSamples(p.body)) samples.push({ page: p.path, ...s });
  const unknown = samples.filter((s) => !spec.ops.has(s.op));
  const notInPre = samples.filter((s) => !s.inPre);
  const metrics = { samples: samples.length, spec_operations: spec.ops.size, unknown: unknown.length };
  if (unknown.length || notInPre.length) {
    const details = { unknown: first(unknown), not_in_pre: first(notInPre) };
    const parts = [];
    if (unknown.length) parts.push(`${plural(unknown.length, "sample")} name an operationId missing from ${spec.file}`);
    if (notInPre.length) parts.push(`${plural(notInPre.length, "<code data-op>")} not inside <pre>`);
    return gate(id, "fail", parts.join("; "), metrics, details);
  }
  if (samples.length === 0)
    return gate(id, "warn", `no <pre><code data-op> samples in the docs (${spec.ops.size} operations in ${spec.file})`, metrics);
  return gate(id, "pass", `${plural(samples.length, "code sample")} all name operations in ${spec.file}`, metrics);
}

// ---------------------------------------------------------------------------------------------
// Text scans over the repository, the build output and the deployed pages

export interface CorpusFile {
  /** Label shown in results, e.g. "repo:src/a.ts", "build:index.html", "deployed:/docs/". */
  name: string;
  text: string;
}

export const SECRET_PATTERNS: [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["stripe-live-key", /\b[rs]k_live_[A-Za-z0-9]{20,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["assigned-secret", /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|api[_-]?token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=.]{20,}["']/i],
];

/** Scan for secret patterns. Results name the file, line and kind, never the matched value. */
export function secretsGate(corpus: CorpusFile[]): Gate {
  const id = "secrets";
  if (corpus.length === 0) return gate(id, "fail", "cannot run: nothing to scan");
  const hits: { file: string; line: number; kind: string }[] = [];
  for (const f of corpus) {
    const lines = f.text.split("\n");
    lines.forEach((line, i) => {
      if (line.length > 20_000) line = line.slice(0, 20_000);
      for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) hits.push({ file: f.name, line: i + 1, kind });
    });
  }
  return hits.length
    ? gate(id, "fail", `${plural(hits.length, "possible secret")} found (values not shown)`, { files: corpus.length, hits: hits.length }, { hits: first(hits) })
    : gate(id, "pass", `no secret patterns in ${plural(corpus.length, "file")}`, { files: corpus.length });
}

export function readCanaries(file: string): string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Canary strings must not appear anywhere. Results name canary by index, never by value. */
export function canaryGate(canaries: string[] | null, corpus: CorpusFile[], why?: string): Gate {
  const id = "canary";
  if (why) return gate(id, "fail", `cannot run: ${why}`);
  if (canaries === null) return gate(id, "skip", "not requested (no --canary-file)");
  if (canaries.length === 0) return gate(id, "fail", "cannot run: the canary file has no canary strings");
  if (corpus.length === 0) return gate(id, "fail", "cannot run: nothing to scan");
  const hits: { file: string; canary: number }[] = [];
  for (const f of corpus) canaries.forEach((c, i) => f.text.includes(c) && hits.push({ file: f.name, canary: i + 1 }));
  return hits.length
    ? gate(id, "fail", `canary string found in ${plural(new Set(hits.map((h) => h.file)).size, "file")}`, { canaries: canaries.length, hits: hits.length }, { hits: first(hits) })
    : gate(id, "pass", `${plural(canaries.length, "canary string")} absent from ${plural(corpus.length, "file")}`, { canaries: canaries.length, files: corpus.length });
}
