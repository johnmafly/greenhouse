// mock-figures (decision 0008, rule 1): package sites show confident, full sample results, and say
// so in one place. Every mock figure is marked `data-mock` (on the number itself or on the table,
// chart or card that holds it), the note "Sample figures for the private preview" sits beside it
// (in the same figure, table, section, article or aside), and the project's MOCK_FIGURES.md lists
// every number shown, by page.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { parseAttrs, stripNonContent, visibleText } from "./html.ts";
import { htmlPages } from "./site.ts";
import type { Site } from "./site.ts";

export const SAMPLE_NOTE = "Sample figures for the private preview";
export const MOCK_FILE = "MOCK_FIGURES.md";
const NOTE_RE = new RegExp(SAMPLE_NOTE.replace(/ /g, "\\s+"), "i");
/** Containers a mock figure's note must share with it ("beside"). */
const CONTAINERS = new Set(["figure", "table", "section", "article", "aside"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function hasSampleNote(text: string): boolean {
  return NOTE_RE.test(text.replace(/\s+/g, " "));
}

/** Numbers in a piece of text, normalised: "1,200" -> "1200", "99.20" stays "99.20". */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
}

interface El {
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
  parent: number;
}

/** Elements of a page (comments, scripts and styles removed) with their source ranges. */
export function elements(html: string): { src: string; els: El[] } {
  const src = stripNonContent(html);
  const els: El[] = [];
  const stack: number[] = [];
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const name = m[2].toLowerCase();
    const at = m.index ?? 0;
    if (m[1]) {
      const i = stack.findLastIndex((k) => els[k].name === name);
      if (i < 0) continue;
      for (const k of stack.splice(i)) els[k].end = at + m[0].length;
      continue;
    }
    const el: El = { name, attrs: parseAttrs(m[3]), start: at, end: src.length, parent: stack.at(-1) ?? -1 };
    els.push(el);
    if (!VOID.has(name) && !m[3].trim().endsWith("/")) stack.push(els.length - 1);
  }
  return { src, els };
}

export interface MockListing {
  /** Page path -> numbers listed for it. */
  byPage: Map<string, Set<string>>;
  rows: number;
  problems: string[];
}

const normPath = (p: string) => {
  const q = p.split(/[?#]/)[0];
  return q.endsWith("/") || /\.[a-z0-9]+$/i.test(q) ? q : `${q}/`;
};

/**
 * MOCK_FIGURES.md: Markdown table(s) whose header has a "Page" and a "Figure" column. Each row names
 * one or more site paths (comma or space separated) and the figure as shown ("99.2% of bots
 * stopped", "p99 3 ms"); every number in the figure cell is listed for those pages.
 */
export function parseMockFigures(md: string): MockListing {
  const byPage = new Map<string, Set<string>>();
  const problems: string[] = [];
  let rows = 0;
  let cols: { page: number; figure: number } | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      cols = null;
      continue;
    }
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const lower = cells.map((c) => c.toLowerCase());
    if (!cols) {
      const page = lower.indexOf("page");
      const figure = lower.findIndex((c) => c === "figure" || c === "figures");
      if (page >= 0 && figure >= 0) cols = { page, figure };
      continue;
    }
    const pages = (cells[cols.page] ?? "").replace(/`/g, "").split(/[\s,]+/).filter((p) => p.startsWith("/"));
    const nums = numbersIn(cells[cols.figure] ?? "");
    if (!pages.length) {
      problems.push(`row "${line.slice(0, 80)}" names no page path`);
      continue;
    }
    rows++;
    for (const p of pages) {
      const set = byPage.get(normPath(p)) ?? new Set<string>();
      for (const n of nums) set.add(n);
      byPage.set(normPath(p), set);
    }
  }
  if (!rows) problems.push(`no table with "Page" and "Figure" columns and at least one row`);
  return { byPage, rows, problems };
}

export interface MockOnPage {
  path: string;
  /** Mock-marked elements: their text, numbers and whether the note is beside them. */
  figures: { text: string; numbers: string[]; note_beside: boolean }[];
  /** The sample note appears somewhere on the page. */
  note: boolean;
}

/** The mock figures one page marks, with the note check. */
export function mockOnPage(html: string, path: string): MockOnPage {
  const { src, els } = elements(html);
  const textOf = (e: El) => visibleText(src.slice(e.start, e.end));
  const figures: MockOnPage["figures"] = [];
  els.forEach((e) => {
    if (!("data-mock" in e.attrs)) return;
    // A data-mock inside another data-mock is counted once, with its outermost element.
    for (let p = e.parent; p >= 0; p = els[p].parent) if ("data-mock" in els[p].attrs) return;
    let c = e.parent;
    while (c >= 0 && !CONTAINERS.has(els[c].name)) c = els[c].parent;
    const own = textOf(e);
    const around = c >= 0 ? textOf(els[c]) : visibleText(src);
    figures.push({ text: own.slice(0, 160), numbers: numbersIn(own), note_beside: hasSampleNote(CONTAINERS.has(e.name) ? own : around) || hasSampleNote(own) });
  });
  return { path, figures, note: hasSampleNote(visibleText(src)) };
}

/** Mock figures by page for a crawled site (claim-sweep uses this to skip listed sample figures). */
export function readMockListing(dir: string | null): MockListing | null {
  if (!dir) return null;
  const f = join(dir, MOCK_FILE);
  return existsSync(f) ? parseMockFigures(readFileSync(f, "utf8")) : null;
}

/**
 * True when every number in `sentence` is a mock figure MOCK_FIGURES.md lists for `page`, and the
 * page carries the sample note. Such a sentence is a labelled sample, not an outside claim.
 */
export function isListedMock(sentence: string, page: string, pageHasNote: boolean, listing: MockListing | null): boolean {
  if (!listing || !pageHasNote) return false;
  const nums = numbersIn(sentence);
  const listed = listing.byPage.get(normPath(page));
  return nums.length > 0 && !!listed && nums.every((n) => listed.has(n));
}

export function mockFiguresGate(site: Site | null, dir: string | null, why = "no site to check"): Gate {
  const id = "mock-figures";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  const pages = htmlPages(site).map((p) => mockOnPage(p.body, p.path));
  const marked = pages.filter((p) => p.figures.length);
  const noted = pages.filter((p) => p.note);
  const listing = readMockListing(dir);
  if (!marked.length && !noted.length && !listing) return gate(id, "pass", "no mock figures marked and no sample note on any page", { pages: pages.length, pages_with_mock: 0 });

  const problems: { page: string; problem: string; figure?: string }[] = [];
  const warnings: string[] = [];
  if (!dir) problems.push({ page: "-", problem: `cannot read ${MOCK_FILE}: no clean checkout of the submitted sha` });
  else if (!listing && (marked.length || noted.length)) problems.push({ page: "-", problem: `${MOCK_FILE} is missing from the repository root, and the site shows mock figures` });
  if (listing) for (const p of listing.problems) problems.push({ page: MOCK_FILE, problem: p });
  for (const p of noted) if (!p.figures.length) problems.push({ page: p.path, problem: `the sample note is on the page but no figure is marked data-mock` });
  for (const p of marked) {
    const listed = listing?.byPage.get(normPath(p.path)) ?? new Set<string>();
    for (const f of p.figures) {
      if (!f.note_beside) problems.push({ page: p.path, problem: `no "${SAMPLE_NOTE}" note beside the mock figure (same figure, table, section, article or aside)`, figure: f.text });
      if (!f.numbers.length) problems.push({ page: p.path, problem: "a data-mock element shows no number", figure: f.text });
      const missing = f.numbers.filter((n) => !listed.has(n));
      if (listing && missing.length) problems.push({ page: p.path, problem: `${MOCK_FILE} does not list ${missing.slice(0, 6).join(", ")} for ${p.path}`, figure: f.text });
    }
  }
  if (listing) {
    const crawled = new Set(pages.map((p) => normPath(p.path)));
    const withMock = new Set(marked.map((p) => normPath(p.path)));
    for (const p of listing.byPage.keys()) {
      if (!crawled.has(p)) warnings.push(`${MOCK_FILE} lists ${p}, which the crawl did not reach`);
      else if (!withMock.has(p)) warnings.push(`${MOCK_FILE} lists ${p}, which marks no mock figure`);
    }
  }
  const metrics = {
    pages: pages.length,
    pages_with_mock: marked.length,
    mock_elements: marked.reduce((n, p) => n + p.figures.length, 0),
    mock_numbers: marked.reduce((n, p) => n + p.figures.reduce((k, f) => k + f.numbers.length, 0), 0),
    listed_rows: listing?.rows ?? 0,
    problems: problems.length,
  };
  const details = { problems: problems.slice(0, 50), warnings: warnings.slice(0, 20), pages: marked.map((p) => ({ path: p.path, figures: p.figures.slice(0, 20) })) };
  if (problems.length) return gate(id, "fail", `${problems.length} mock-figure problem${problems.length === 1 ? "" : "s"}: ${problems.slice(0, 3).map((p) => `${p.page} ${p.problem}`).join("; ")}`, metrics, details);
  const summary = `${metrics.mock_elements} mock figure block${metrics.mock_elements === 1 ? "" : "s"} on ${marked.length} page${marked.length === 1 ? "" : "s"}, each with the sample note beside it and every number listed in ${MOCK_FILE}`;
  return gate(id, warnings.length ? "warn" : "pass", warnings.length ? `${summary}; ${warnings.length} stale listing${warnings.length === 1 ? "" : "s"}` : summary, metrics, details);
}
