// template-likeness (contract v2, design-bar spec section 2): panel evidence on how close the
// site's structure is to the template and to portfolio siblings. It records the nav labels,
// heading outline and route set, and a similarity score; it fails only on near-identity to
// template/ (similarity >= 0.8). Everything else is for the reviewers (sameness cap).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../lib/schemas.ts";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { headingOutline, navLabels, visibleText } from "./html.ts";
import { htmlPages } from "./site.ts";
import type { Site } from "./site.ts";

export const TEMPLATE_SITE = join(REPO_ROOT, "template", "site");
export const LIKENESS_FAIL = 0.8;
const MAX_HOME_WORDS = 600;

/** A site's structure, as stored in checks.json (details.signature) for sibling comparison. */
export interface Signature {
  nav_labels: string[];
  /** h1-h3 headings across all pages, "h2 text". */
  heading_outline: string[];
  /** HTML page paths (404 excluded). */
  routes: string[];
  /** First words of the home page's visible text, lower-cased. */
  home_words: string[];
}

export interface Similarity {
  score: number;
  nav: number;
  outline: number;
  routes: number;
  home_text: number;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.slice(0, MAX_HOME_WORDS) ?? [];
}

export function signatureOf(pages: { path: string; html: string }[]): Signature {
  const sorted = [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const home = sorted.find((p) => p.path === "/");
  const outline: string[] = [];
  for (const p of sorted) for (const h of headingOutline(p.html)) if (!outline.includes(h)) outline.push(h);
  return {
    nav_labels: home ? navLabels(home.html) : [],
    heading_outline: outline,
    routes: sorted.map((p) => p.path),
    home_words: home ? words(visibleText(home.html)) : [],
  };
}

export function siteSignature(site: Site): Signature {
  return signatureOf(htmlPages(site).map((p) => ({ path: p.path, html: p.body })));
}

/** The template's own pages, read from template/site (404.html excluded). */
export function templateSignature(dir = TEMPLATE_SITE): Signature {
  const pages: { path: string; html: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (name.endsWith(".html") && name !== "404.html") {
        const rel = relative(dir, f).split(sep).join("/");
        const path = "/" + (rel === "index.html" ? "" : rel.endsWith("/index.html") ? rel.slice(0, -"index.html".length) : rel);
        pages.push({ path, html: readFileSync(f, "utf8") });
      }
    }
  };
  walk(dir);
  return signatureOf(pages);
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function shingles(ws: string[], n = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(" "));
  return out.length ? out : ws;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Mean of four Jaccard similarities: nav labels, heading outline, routes, home-page 3-word shingles. */
export function similarity(a: Signature, b: Signature): Similarity {
  const nav = jaccard(a.nav_labels, b.nav_labels);
  const outline = jaccard(a.heading_outline, b.heading_outline);
  const routes = jaccard(a.routes, b.routes);
  const home_text = jaccard(shingles(a.home_words), shingles(b.home_words));
  return { score: r3((nav + outline + routes + home_text) / 4), nav: r3(nav), outline: r3(outline), routes: r3(routes), home_text: r3(home_text) };
}

export interface SiblingSignature {
  slug: string;
  sha: string | null;
  signature: Signature;
  source: string;
}

/** Signatures from other projects' checks.json files (gate template-likeness, details.signature). */
export function readSiblings(files: string[], selfSlug: string): { siblings: SiblingSignature[]; errors: string[] } {
  const siblings: SiblingSignature[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      if (!existsSync(f)) throw new Error("not found");
      const doc = JSON.parse(readFileSync(f, "utf8"));
      const sig = doc?.gates?.find((g: { id: string }) => g.id === "template-likeness")?.details?.signature as Signature | undefined;
      if (!sig || !Array.isArray(sig.nav_labels) || !Array.isArray(sig.heading_outline) || !Array.isArray(sig.routes) || !Array.isArray(sig.home_words))
        throw new Error("no template-likeness signature in it");
      if (doc.slug === selfSlug) continue;
      siblings.push({ slug: String(doc.slug), sha: typeof doc.sha === "string" ? doc.sha : null, signature: sig, source: f });
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { siblings, errors };
}

export function templateLikenessGate(site: Site | null, why = "no site to check", siblings: SiblingSignature[] = [], siblingErrors: string[] = [], template: Signature = templateSignature()): Gate {
  const id = "template-likeness";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  if (htmlPages(site).length === 0) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const signature = siteSignature(site);
  const vsTemplate = similarity(signature, template);
  const vsSiblings = siblings.map((s) => ({ slug: s.slug, sha: s.sha, ...similarity(signature, s.signature) }));
  const closest = vsSiblings.reduce<(typeof vsSiblings)[number] | null>((m, s) => (!m || s.score > m.score ? s : m), null);
  const metrics: Record<string, number | string | null> = {
    template_similarity: vsTemplate.score,
    siblings: vsSiblings.length,
    max_sibling_similarity: closest ? closest.score : null,
    max_sibling_slug: closest ? closest.slug : null,
  };
  const details = {
    threshold: LIKENESS_FAIL,
    method: "mean of Jaccard similarities: nav labels, h1-h3 heading outline, route set, home-page 3-word shingles",
    template: vsTemplate,
    siblings: vsSiblings,
    ...(siblingErrors.length ? { sibling_errors: siblingErrors } : {}),
    signature,
  };
  const sib = closest ? `; closest sibling ${closest.slug} ${closest.score}` : "";
  return vsTemplate.score >= LIKENESS_FAIL
    ? gate(id, "fail", `near-identical to template/: similarity ${vsTemplate.score} >= ${LIKENESS_FAIL}${sib}`, metrics, details)
    : gate(id, "pass", `similarity to template/ ${vsTemplate.score} (fails at ${LIKENESS_FAIL})${sib}; nav and outline recorded as panel evidence`, metrics, details);
}
