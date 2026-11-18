// Text helpers for the assisted gates: quote matching, sentence extraction, sections by id,
// money amounts and the mechanical candidate finders that decide what the judges are asked.
import { decodeEntities, parseAttrs, stripNonContent, visibleText } from "./html.ts";

/** Compare-friendly text: NFKC, straight quotes and dashes, no zero-width, collapsed, lower case. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032`´]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033«»]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    // Inline tags (<strong>x</strong>, y) leave a space before punctuation once stripped, and French
    // typography puts one before : ; ! ?. Spacing around punctuation is not part of a quote.
    .replace(/ ([,.;:!?)\]])/g, "$1")
    .replace(/([(\[]) /g, "$1")
    .trim()
    .toLowerCase();
}

/**
 * Whether `quote` appears verbatim in `text`, up to whitespace, quote marks, dashes and case.
 * An ellipsis ("..." or "[...]") in the quote marks an omission: the parts must appear in order.
 */
export function quoteFound(text: string, quote: string): boolean {
  const t = normalizeText(text);
  const parts = normalizeText(quote)
    .split(/\s*\[?\.\.\.\]?\s*/)
    .map((p) => p.replace(/^["'\s]+|["'\s.,;:]+$/g, ""))
    .filter((p) => p.length > 0);
  if (!parts.length) return false;
  let at = 0;
  for (const p of parts) {
    const i = t.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return true;
}

const BLOCK_TAGS = "p|li|h[1-6]|td|th|tr|div|section|article|header|aside|blockquote|figcaption|figure|dt|dd|br|hr|table|ul|ol|summary|details|main|label|button|option";

/** Text blocks of a page's content: nav, footer, code and pre removed, one string per block. */
export function contentBlocks(html: string): string[] {
  const s = stripNonContent(html)
    .replace(/<(nav|footer|pre|code|noscript|select)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .split(/\n+/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 0);
}

/** Sentences of the content blocks (split at . ! ? followed by a space and a capital or digit). */
export function sentences(html: string): string[] {
  const out: string[] = [];
  for (const b of contentBlocks(html)) for (const s of b.split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)) if (s.trim()) out.push(s.trim());
  return out;
}

const STOP = new Set(
  "the and for are but not you all any can had her was one our out has have how its may new now see two who did get him his let put say she too use this that with from they will your what when than then them these those into more most some such only over also been were which their there about would could should after other just".split(
    " ",
  ),
);

export function contentTokens(s: string): Set<string> {
  return new Set((normalizeText(s).match(/[\p{L}\p{N}][\p{L}\p{N}.%$-]*/gu) ?? []).map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length >= 3 && !STOP.has(w)));
}

export function numbersIn(s: string): Set<string> {
  return new Set((s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, "")));
}

export interface LedgerClaim {
  id: string;
  claim: string;
  quote: string;
}

/**
 * Whether a sentence on the site is covered by a ledger claim: most of the claim's words are in
 * the sentence, or every number in the sentence is in the claim (or its quote) and the words
 * overlap at least a little.
 */
export function coveredBy(sentence: string, ledger: LedgerClaim[]): string | null {
  const S = contentTokens(sentence);
  const nums = numbersIn(sentence);
  for (const c of ledger) {
    const C = contentTokens(c.claim);
    if (!C.size) continue;
    let inter = 0;
    for (const w of C) if (S.has(w)) inter++;
    const overlap = inter / C.size;
    if (overlap >= 0.6) return c.id;
    if (nums.size && overlap >= 0.25) {
      const cn = new Set([...numbersIn(c.claim), ...numbersIn(c.quote)]);
      if ([...nums].every((n) => cn.has(n))) return c.id;
    }
    if (c.quote && normalizeText(sentence).length >= 20 && quoteFound(c.quote, sentence)) return c.id;
  }
  return null;
}

/** Signals that a sentence states a checkable fact (a figure, a comparison, a superlative, research). */
export const FACT_RE =
  /\d|%|[$€£¥]|\b(according to|reported|reports|survey|study|studies|research|percent|per cent|million|billion|trillion|fastest|largest|biggest|cheapest|leading|most popular|first|only|majority|average|median|times (faster|cheaper|more)|market share)\b/i;

/** The element with this id and its contents; for a heading, the heading and what follows it up to the next heading of the same or a higher level. */
export function elementById(html: string, id: string): string | null {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<([a-zA-Z][\\w-]*)\\b(?:[^>"']|"[^"]*"|'[^']*')*?\\bid\\s*=\\s*(?:"${esc}"|'${esc}'|${esc}(?=[\\s>]))(?:[^>"']|"[^"]*"|'[^']*')*>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const hm = /^h([1-6])$/.exec(tag);
  if (hm) {
    const rest = html.slice(m.index + m[0].length);
    const next = new RegExp(`<h[1-${hm[1]}]\\b|<\\/(section|article|main|body)\\b`, "i").exec(rest);
    return html.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length));
  }
  return elementFrom(html, m.index, tag);
}

/** From a start tag at `start`, the element up to its matching end tag (or the rest of the page). */
export function elementFrom(html: string, start: number, tag: string): string {
  const re = new RegExp(`<(\\/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

/** Money amounts written on a page: $49, $1,200, €9.50, 49 USD. */
export function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(?:US\$|\$|€|£|¥)\s?(\d[\d,]*(?:\.\d+)?)\s?(k\b)?|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|dollars|euros)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number((m[1] ?? m[3]).replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Social proof candidates

export const COUNT_RE =
  /\b(trusted by|used by|loved by|chosen by|relied on by|depended on by|backed by|join(?:ed)?|serving|protect(?:s|ing)?)\b[^.!?]{0,60}?\b\d[\d,.]*\s*(?:k|m|\+)?\+?\s*(?:teams|companies|customers|users|developers|engineers|businesses|organi[sz]ations|sites|stores|brands|enterprises|startups)\b|\b\d[\d,.]*\s*(?:k|m)?\+?\s*(?:teams|companies|customers|users|developers|engineers|businesses|organi[sz]ations|sites|stores|brands|enterprises|startups)\s+(?:use|trust|rely|love|run|protect|chose|choose|switched)\b/i;
export const RATING_RE = /★|\b[1-5](?:\.\d)?\s*(?:\/\s*5|out of 5|stars?)\b|\brated\s+[1-5](?:\.\d)?\b/i;
export const PRESS_RE = /\b(as seen (?:in|on)|featured (?:in|on)|in the press|press coverage|award[- ]winning)\b/i;
export const TRUST_CONTEXT_RE = /\b(trusted by|used by|loved by|our customers|customers include|backed by|partners|as seen|featured)\b/i;
const PROOF_CLASS_RE = /testimonial|review|endorse|customer-?(?:quote|story|logo)|social-?proof|logo-?(?:wall|strip|grid|bar|cloud|row)|trusted-?by|case-?stud/i;
const ATTRIBUTION_RE = /(?:^|\s)[—–-]\s*[A-Z][\p{L}'.-]+(?:\s+[A-Z][\p{L}'.-]+){0,3},\s*[^,\n]{2,60}?\b(?:at|@|of)\s+[A-Z]/u;

export interface Candidate {
  kind: string;
  text: string;
}

function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Things on a page that look like social proof: testimonials, counts, ratings, press, logo walls. */
export function socialProofCandidates(html: string): Candidate[] {
  const clean = stripNonContent(html);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (kind: string, text: string) => {
    const t = text.slice(0, 400);
    const key = normalizeText(t);
    if (!t || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, text: t });
  };
  for (const m of clean.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>([\s\S]{0,300})/gi)) {
    const after = /<(?:figcaption|cite|footer|p)\b[^>]*>([\s\S]*?)<\/(?:figcaption|cite|footer|p)\s*>/i.exec(m[2]);
    add("quote", textOf(m[1]) + (after ? ` (${textOf(after[1])})` : ""));
  }
  const startTag = /<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const m of clean.matchAll(startTag)) {
    const a = parseAttrs(m[2]);
    if (PROOF_CLASS_RE.test(`${a.class ?? ""} ${a.id ?? ""}`)) {
      const el = elementFrom(clean, m.index ?? 0, m[1].toLowerCase());
      const alts = [...el.matchAll(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)].map((i) => parseAttrs(i[1]).alt).filter(Boolean);
      add("proof-element", (textOf(el) + (alts.length ? ` [images: ${alts.join(", ")}]` : "")).trim() || "(element with no text)");
    }
  }
  for (const s of sentences(html)) {
    if (COUNT_RE.test(s)) add("count", s);
    else if (RATING_RE.test(s)) add("rating", s);
    else if (PRESS_RE.test(s)) add("press", s);
    else if (ATTRIBUTION_RE.test(s)) add("attribution", s);
  }
  for (const m of clean.matchAll(new RegExp(TRUST_CONTEXT_RE.source, "gi"))) {
    const win = clean.slice(m.index ?? 0, (m.index ?? 0) + 1500);
    const logos = [...win.matchAll(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)]
      .map((i) => parseAttrs(i[1]))
      .filter((a) => /logo/i.test(`${a.alt ?? ""} ${a.src ?? ""} ${a.class ?? ""}`));
    if (logos.length >= 2) add("logo-wall", `${m[0]}: ${logos.map((l) => l.alt || l.src).join(", ")}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text aimed at reviewers

/** Unambiguous attempts to instruct a model or reviewer: fail without asking the judges. */
export const STRONG_INSTRUCTION_PATTERNS: [string, RegExp][] = [
  ["ignore previous instructions", /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|other)\s+(instructions?|prompts?|directions|rules)\b/i],
  ["score request", /\b(give|assign|award|rate|score|grade)\s+(this|it|the|our)(\s+(site|product|project|package|page|submission))?\s+(a\s+|an\s+)?(perfect|top|full|maximum|max|high(est)?|\d+(\.\d+)?\s*(\/|out of)\s*10|10|9(\.\d)?)\b/i],
  ["note to the model", /\b(note|message|instructions?|attention|hint)\s+(to|for)\s+(the\s+|any\s+)?(ai|llm|language model|model|reviewers?|judges?|graders?|evaluators?|scorers?)\b/i],
  ["address to the model", /\b(dear|attention|hey|hello)\s*,?\s+(ai|llm|language model|reviewer|judge|grader|evaluator|assistant)\b/i],
  ["system prompt", /\b(system prompt|new instructions:|<\/?system>|\[\/?INST\])/i],
];

export const REVIEWER_WORD_RE =
  /\b(reviewers?|judges?|judging|graders?|grading|evaluators?|evaluat(e|ing|ion)|scor(e|es|ed|ing)|rubric|panel|graduat\w*|greenhouse|llms?|language models?|ai (?:models?|assistants?|agents?|reviewers?)|chatgpt|gpt-?\d[\w.-]*|claude|gemini)\b/i;
const VISIBLE_REVIEWER_RE = /\b(reviewers?|judges?|graders?|evaluators?|rubric|greenhouse|scor(e|ing) (this|the) (site|product|page))\b/i;
const SECOND_PERSON_RE = /\b(you|your|please|should|must)\b/i;

export interface HiddenSource {
  where: string;
  text: string;
}

/** Text a person reading the page does not see: comments, attributes, noscript, meta. */
export function invisibleTexts(html: string): HiddenSource[] {
  const out: HiddenSource[] = [];
  for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) if (m[1].trim()) out.push({ where: "html comment", text: m[1].replace(/\s+/g, " ").trim() });
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of noComments.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi)) {
    const t = textOf(m[1]);
    if (t) out.push({ where: "noscript", text: t });
  }
  for (const m of noComments.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) out.push({ where: "json-ld", text: m[1].replace(/\s+/g, " ").trim() });
  for (const m of noComments.matchAll(/<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const a = parseAttrs(m[2]);
    for (const [k, v] of Object.entries(a)) {
      if (!v || v.length < 12) continue;
      if (["alt", "title", "aria-label", "aria-description", "placeholder"].includes(k) || k.startsWith("data-") || (m[1].toLowerCase() === "meta" && k === "content"))
        out.push({ where: `${m[1].toLowerCase()}[${k}]`, text: v.replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

export interface InstructionHit {
  where: string;
  text: string;
  pattern?: string;
}

/** Strong hits (anywhere in the raw page, scripts included) and weak candidates for the judges. */
export function instructionCandidates(raw: string, hidden: HiddenSource[] = []): { strong: InstructionHit[]; weak: InstructionHit[] } {
  const strong: InstructionHit[] = [];
  const weak: InstructionHit[] = [];
  const snippet = (s: string, i: number) => s.slice(Math.max(0, i - 120), i + 200).replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const addWeak = (h: InstructionHit) => {
    const k = normalizeText(h.text);
    if (seen.has(k)) return;
    seen.add(k);
    weak.push({ ...h, text: h.text.slice(0, 500) });
  };
  // A strong pattern hidden from people (comments, attributes, scripts, hidden elements) fails
  // outright; the same words in visible text (a page explaining prompt injection, say) go to the
  // judges instead.
  const visible = normalizeText(visibleText(raw));
  for (const [name, re] of STRONG_INSTRUCTION_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of raw.matchAll(g)) {
      const hit = { where: "page source", pattern: name, text: snippet(raw, m.index ?? 0) };
      if (visible.includes(normalizeText(m[0]))) addWeak({ ...hit, where: "visible text" });
      else strong.push(hit);
    }
    for (const h of hidden)
      for (const m of h.text.matchAll(g)) strong.push({ where: h.where, pattern: name, text: snippet(h.text, m.index ?? 0) });
  }
  for (const h of [...invisibleTexts(raw), ...hidden]) if (REVIEWER_WORD_RE.test(h.text)) addWeak(h);
  for (const s of sentences(raw)) if (VISIBLE_REVIEWER_RE.test(s) && SECOND_PERSON_RE.test(s)) addWeak({ where: "visible text", text: s });
  return { strong, weak };
}
