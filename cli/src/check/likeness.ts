// template-likeness (contract v2, design-bar spec section 2): panel evidence on how close the
// site's structure is to the template and to portfolio siblings. It records the nav labels,
// heading outline and route set, and a similarity score; it fails only on near-identity to
// template/ (similarity >= 0.8). Everything else is for the reviewers (sameness cap).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Browser } from "playwright";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../lib/schemas.ts";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { headingOutline, navLabels, visibleText } from "./html.ts";
import { serveStatic } from "./serve.ts";
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
  /** Screenshot measure of the home page's first screen (absent without a browser). */
  visual?: VisualSignature | null;
}

/** The home page's first screen at 1440x900, reduced to a 32x20 luminance grid and a 64-bin colour histogram. */
export interface VisualSignature {
  viewport: string;
  /** 640 luminance values, 0-255, row by row. */
  grid: number[];
  /** 64 bins (4 levels per RGB channel), per mille of the pixels. */
  hist: number[];
}

export const VISUAL_WARN = 0.9;
const GRID_W = 32;
const GRID_H = 20;

/** Screenshot the first screen of `url` and reduce it in the browser (no image library needed). */
export async function visualSignature(browser: Browser, url: string): Promise<VisualSignature> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(500);
    const png = await page.screenshot({ type: "png" });
    // Decode on a blank page: the site's own CSP may block data: images.
    const blank = await ctx.newPage();
    const out = await blank.evaluate(
      async ({ b64, w, h }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d")!;
        x.drawImage(img, 0, 0, w, h);
        const d = x.getImageData(0, 0, w, h).data;
        const grid: number[] = [];
        for (let i = 0; i < d.length; i += 4) grid.push(Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]));
        const H = document.createElement("canvas");
        H.width = 180;
        H.height = 112;
        const hx = H.getContext("2d")!;
        hx.drawImage(img, 0, 0, 180, 112);
        const hd = hx.getImageData(0, 0, 180, 112).data;
        const bins = new Array(64).fill(0);
        for (let i = 0; i < hd.length; i += 4) bins[(hd[i] >> 6) * 16 + (hd[i + 1] >> 6) * 4 + (hd[i + 2] >> 6)]++;
        const n = hd.length / 4;
        return { grid, hist: bins.map((b) => Math.round((b / n) * 1000)) };
      },
      { b64: png.toString("base64"), w: GRID_W, h: GRID_H },
    );
    return { viewport: "1440x900", ...out };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

let templateVisualCache: VisualSignature | null = null;
/** The template's home page, served locally from template/site. */
export async function templateVisual(browser: Browser, dir = TEMPLATE_SITE): Promise<VisualSignature> {
  if (templateVisualCache && dir === TEMPLATE_SITE) return templateVisualCache;
  const server = await serveStatic(dir);
  try {
    const v = await visualSignature(browser, server.url);
    if (dir === TEMPLATE_SITE) templateVisualCache = v;
    return v;
  } finally {
    await server.close();
  }
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  // Two flat screens: alike when their brightness is alike.
  if (va < 1e-6 || vb < 1e-6) return va < 1e-6 && vb < 1e-6 ? 1 - Math.abs(ma - mb) / 255 : 0;
  return num / Math.sqrt(va * vb);
}

/** Mean of colour-histogram intersection and the luminance grid's correlation (floored at 0). */
export function visualSimilarity(a: VisualSignature, b: VisualSignature): { score: number; colour: number; layout: number } {
  let inter = 0;
  for (let i = 0; i < 64; i++) inter += Math.min(a.hist[i] ?? 0, b.hist[i] ?? 0);
  const colour = Math.min(1, inter / 1000);
  const layout = Math.max(0, pearson(a.grid, b.grid));
  return { score: r3((colour + layout) / 2), colour: r3(colour), layout: r3(layout) };
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

export interface VisualInput {
  /** The checked site's home page; null when there was no browser (the reason is in error). */
  self: VisualSignature | null;
  template: VisualSignature | null;
  error?: string;
}

export function templateLikenessGate(
  site: Site | null,
  why = "no site to check",
  siblings: SiblingSignature[] = [],
  siblingErrors: string[] = [],
  template: Signature = templateSignature(),
  visual: VisualInput = { self: null, template: null, error: "no browser" },
): Gate {
  const id = "template-likeness";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  if (htmlPages(site).length === 0) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const signature: Signature = { ...siteSignature(site), visual: visual.self };
  const vsTemplate = similarity(signature, template);
  const vsSiblings = siblings.map((s) => ({ slug: s.slug, sha: s.sha, ...similarity(signature, s.signature) }));
  const visTemplate = visual.self && visual.template ? visualSimilarity(visual.self, visual.template) : null;
  const visSiblings = visual.self
    ? siblings.filter((s) => s.signature.visual).map((s) => ({ slug: s.slug, ...visualSimilarity(visual.self!, s.signature.visual!) }))
    : [];
  const visClosest = visSiblings.reduce<(typeof visSiblings)[number] | null>((m, s) => (!m || s.score > m.score ? s : m), null);
  const visualNear = [
    ...(visTemplate && visTemplate.score >= VISUAL_WARN ? [`template/ ${visTemplate.score}`] : []),
    ...visSiblings.filter((s) => s.score >= VISUAL_WARN).map((s) => `${s.slug} ${s.score}`),
  ];
  const closest = vsSiblings.reduce<(typeof vsSiblings)[number] | null>((m, s) => (!m || s.score > m.score ? s : m), null);
  const metrics: Record<string, number | string | null> = {
    template_similarity: vsTemplate.score,
    siblings: vsSiblings.length,
    max_sibling_similarity: closest ? closest.score : null,
    max_sibling_slug: closest ? closest.slug : null,
    visual_template_similarity: visTemplate ? visTemplate.score : null,
    max_sibling_visual_similarity: visClosest ? visClosest.score : null,
  };
  const details = {
    threshold: LIKENESS_FAIL,
    method: "mean of Jaccard similarities: nav labels, h1-h3 heading outline, route set, home-page 3-word shingles",
    template: vsTemplate,
    siblings: vsSiblings,
    visual: {
      method: "first screen at 1440x900 (reduced motion): mean of 64-bin colour-histogram intersection and 32x20 luminance-grid correlation",
      warn_at: VISUAL_WARN,
      template: visTemplate,
      siblings: visSiblings,
      ...(visual.error ? { error: visual.error } : {}),
    },
    ...(siblingErrors.length ? { sibling_errors: siblingErrors } : {}),
    signature,
  };
  const sib = closest ? `; closest sibling ${closest.slug} ${closest.score}` : "";
  const vis = visTemplate ? `; looks ${visTemplate.score} like template/` : visual.error ? `; no visual measure (${visual.error})` : "";
  if (vsTemplate.score >= LIKENESS_FAIL)
    return gate(id, "fail", `near-identical to template/: similarity ${vsTemplate.score} >= ${LIKENESS_FAIL}${sib}${vis}`, metrics, details);
  if (visualNear.length)
    return gate(id, "warn", `structure ${vsTemplate.score} like template/, but the first screen looks near-identical to ${visualNear.join(", ")} (warns at ${VISUAL_WARN})${sib}`, metrics, details);
  return gate(id, "pass", `similarity to template/ ${vsTemplate.score} (fails at ${LIKENESS_FAIL})${sib}${vis}; nav and outline recorded as panel evidence`, metrics, details);
}
