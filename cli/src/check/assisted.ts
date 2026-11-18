// Assisted gates (plan v7 section 6, issue #12): a mechanical proof first, then two model judges
// from different families on the one question the mechanics cannot settle.
//
//   claims               every claims.yaml source fetched and archived, the quote found verbatim,
//                        both judges say the quote supports the claim          (cap: unsupported_claim)
//   claim-sweep          factual sentences on the site that no ledger claim covers
//   pricing              the pricing content reconciles with greenhouse.yaml cost_model
//   social-proof         testimonials, logos, customer counts, ratings, press   (cap: invented_social_proof)
//   reviewer-instruction text aimed at reviewers or models                     (cap: reviewer_instruction)
//   hidden-text          text hidden from people, and content served differently to crawlers
//
// Judgement rule: a problem the mechanics prove fails on its own. A candidate only the judges can
// settle fails when both judges agree it is a problem, and warns when they split (disagree, say
// unclear, or error), so the panel sees it. A claim passes only when both judges say "yes".
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { parse as parseYaml } from "yaml";
import { validate } from "../lib/schemas.ts";
import type { Gate, GateStatus } from "../lib/schemas.ts";
import { BROWSER_USER_AGENT, classifyStatus, errorLabel, fresh, mapLimit } from "./claim-links.ts";
import type { ContentMap } from "./content.ts";
import { visibleText } from "./html.ts";
import { askBoth, judgePairProblem, request } from "./judge.ts";
import type { Judge, JudgeVote, Verdict } from "./judge.ts";
import { fetchPage, htmlPages } from "./site.ts";
import type { Site } from "./site.ts";
import {
  FACT_RE,
  contentTokens,
  coveredBy,
  elementById,
  instructionCandidates,
  moneyAmounts,
  normalizeText,
  quoteFound,
  sentences,
  socialProofCandidates,
} from "./text.ts";
import type { HiddenSource, LedgerClaim } from "./text.ts";

export const ASSISTED_GATE_IDS = ["claims", "claim-sweep", "pricing", "social-proof", "reviewer-instruction", "hidden-text"] as const;

export function agate(id: string, status: GateStatus, summary: string, metrics?: Gate["metrics"], details?: unknown): Gate {
  const g: Gate = { id, class: "assisted", status, summary };
  if (metrics !== undefined) g.metrics = metrics;
  if (details !== undefined) g.details = details;
  return g;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const votesOf = (v: Verdict) => v.votes.map((x: JudgeVote) => ({ judge: x.judge, family: x.family, answer: x.answer, reason: x.reason }));

function worst(statuses: GateStatus[]): GateStatus {
  return statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
}

// ---------------------------------------------------------------------------------------------
// claims

export interface SourceFetch {
  status: number | string;
  finalUrl: string;
  contentType: string;
  body: Buffer | null;
  note?: string;
}
export type SourceFetcher = (url: string) => Promise<SourceFetch>;
/** Renders a source in a browser and returns its text (for pages that build their text with JavaScript). */
export type SourceRenderer = (url: string) => Promise<string | null>;

const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function defaultSourceFetcher(timeoutMs = 30_000, retryDelayMs = 3_000): SourceFetcher {
  const once = async (url: string): Promise<SourceFetch> => {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": BROWSER_USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
      });
      const contentType = res.headers.get("content-type") ?? "";
      let body: Buffer | null = null;
      if (res.status >= 200 && res.status < 300) {
        const buf = Buffer.from(await res.arrayBuffer());
        body = buf.length > MAX_SOURCE_BYTES ? buf.subarray(0, MAX_SOURCE_BYTES) : buf;
      } else await res.body?.cancel().catch(() => undefined);
      return { status: res.status, finalUrl: res.url || url, contentType, body };
    } catch (e) {
      return { status: errorLabel(e), finalUrl: url, contentType: "", body: null };
    }
  };
  return async (url) => {
    const r = await once(url);
    if (r.status !== 429) return r;
    await sleep(retryDelayMs);
    return { ...(await once(url)), note: "429 retried once" };
  };
}

/** Browser renderer for sources whose text needs JavaScript. */
export function browserRenderer(browser: Browser, timeoutMs = 30_000): SourceRenderer {
  return async (url) => {
    const ctx = await browser.newContext({ userAgent: BROWSER_USER_AGENT });
    try {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      return await page.evaluate(() => document.body?.innerText ?? "");
    } catch {
      return null;
    } finally {
      await ctx.close().catch(() => undefined);
    }
  };
}

function sourceText(f: SourceFetch): { text: string | null; kind: string } {
  if (!f.body) return { text: null, kind: "none" };
  const ct = f.contentType.toLowerCase();
  const raw = f.body.toString("utf8");
  if (/html|xml/.test(ct) || (!ct && /<html|<body/i.test(raw.slice(0, 2000)))) return { text: visibleText(raw), kind: "html" };
  if (/^text\/|json|yaml|markdown/.test(ct)) return { text: raw, kind: "text" };
  return { text: null, kind: ct.split(";")[0] || "unknown" };
}

function extFor(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("html")) return "html";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("json")) return "json";
  if (ct.includes("xml")) return "xml";
  if (ct.startsWith("text/")) return "txt";
  return "bin";
}

export interface ArchiveEntry {
  url: string;
  final_url: string;
  status: number | string;
  content_type: string;
  fetched_at: string;
  sha256: string | null;
  file: string | null;
  bytes: number;
}

interface LedgerEntry extends LedgerClaim {
  where: string[];
  source_url: string;
  checked: unknown;
}

export function readLedger(dir: string): { claims: LedgerEntry[]; error?: string } {
  const file = join(dir, "claims.yaml");
  if (!existsSync(file)) return { claims: [], error: "claims.yaml is missing" };
  let doc: any;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return { claims: [], error: `claims.yaml does not parse: ${(e as Error).message.split("\n")[0]}` };
  }
  const v = validate("claims", structuredClone(doc));
  if (!v.valid) return { claims: [], error: `claims.yaml is not schema-valid: ${v.errors.slice(0, 3).join("; ")}` };
  return {
    claims: (doc.claims as any[]).map((c) => ({ id: String(c.id), claim: String(c.claim), quote: String(c.quote), where: c.where, source_url: String(c.source_url), checked: c.checked })),
  };
}

export interface ClaimsOptions {
  now?: Date;
  /** Where fetched sources are written (index.json plus one file per body); null: not archived. */
  archiveDir?: string | null;
  fetcher?: SourceFetcher;
  renderer?: SourceRenderer | null;
  concurrency?: number;
}

type ClaimClass = "supported" | "unsupported" | "not_both_judges" | "quote_not_found" | "source_broken" | "source_unverifiable";

export async function claimsGate(dir: string | null, judges: Judge[], opts: ClaimsOptions = {}): Promise<Gate> {
  const id = "claims";
  if (!dir) return agate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  const pair = judgePairProblem(judges);
  if (pair) return agate(id, "fail", `cannot run: ${pair}`);
  const ledger = readLedger(dir);
  if (ledger.error) return agate(id, "fail", `cannot run: ${ledger.error}`);
  if (!ledger.claims.length) return agate(id, "pass", "claims.yaml lists no claims (claim-sweep looks for claims missing from it)", { claims: 0 });
  const now = opts.now ?? new Date();
  const fetcher = opts.fetcher ?? defaultSourceFetcher();

  // One fetch per distinct URL, archived once.
  const urls = [...new Set(ledger.claims.map((c) => c.source_url))];
  const fetched = new Map<string, { f: SourceFetch; text: string | null; kind: string; archive: ArchiveEntry }>();
  if (opts.archiveDir) mkdirSync(opts.archiveDir, { recursive: true });
  await mapLimit(urls, opts.concurrency ?? 6, async (url) => {
    const f = await fetcher(url);
    const st = sourceText(f);
    let sha256: string | null = null;
    let file: string | null = null;
    if (f.body) {
      sha256 = createHash("sha256").update(f.body).digest("hex");
      if (opts.archiveDir) {
        file = `${sha256}.${extFor(f.contentType)}`;
        writeFileSync(join(opts.archiveDir, file), f.body);
      }
    }
    fetched.set(url, {
      f,
      ...st,
      archive: { url, final_url: f.finalUrl, status: f.status, content_type: f.contentType, fetched_at: new Date().toISOString(), sha256, file, bytes: f.body?.length ?? 0 },
    });
  });
  if (opts.archiveDir)
    writeFileSync(join(opts.archiveDir, "index.json"), JSON.stringify(urls.map((u) => fetched.get(u)!.archive), null, 2) + "\n");

  const results = await mapLimit(ledger.claims, opts.concurrency ?? 4, async (c) => {
    const src = fetched.get(c.source_url)!;
    const cls = classifyStatus(src.f.status);
    let quote_found: boolean | null = null;
    let verifiedBy: "static" | "rendered" | null = null;
    if (src.text !== null) {
      quote_found = quoteFound(src.text, c.quote);
      if (quote_found) verifiedBy = "static";
      else if (opts.renderer && src.kind === "html") {
        const rendered = await opts.renderer(src.f.finalUrl);
        if (rendered && quoteFound(rendered, c.quote)) {
          quote_found = true;
          verifiedBy = "rendered";
        }
      }
    }
    const base = {
      id: c.id,
      source_url: c.source_url,
      status: src.f.status,
      archived: src.archive.file,
      quote_found,
      ...(verifiedBy ? { quote_verified_in: verifiedBy } : {}),
    };
    if (cls === "broken") return { ...base, class: "source_broken" as ClaimClass, outcome: "fail" as GateStatus, why: `source returned ${src.f.status}` };
    if (quote_found === false) return { ...base, class: "quote_not_found" as ClaimClass, outcome: "fail" as GateStatus, why: "the quote is not in the source" };
    const unverifiable = quote_found === null; // refused automation, or a body we cannot read (PDF, image)
    const verdict = await askBoth(
      judges,
      request(
        "claim-support",
        "Does the quote, taken from the source, support the claim exactly as written (not a stronger, broader, newer or more specific version of it)? Answer yes only if a careful reader would agree the source says this.",
        { claim: c.claim, quote: c.quote, source_url: c.source_url, quote_verified_in_source: !unverifiable },
      ),
    );
    const votes = votesOf(verdict);
    if (verdict.outcome === "no") return { ...base, class: "unsupported" as ClaimClass, outcome: "fail" as GateStatus, why: "both judges: the quote does not support the claim", votes };
    if (verdict.outcome === "split") return { ...base, class: "not_both_judges" as ClaimClass, outcome: "fail" as GateStatus, why: "the judges did not both say the quote supports the claim", votes };
    if (unverifiable) {
      const ok = fresh(c.checked, now);
      return {
        ...base,
        class: "source_unverifiable" as ClaimClass,
        outcome: (ok ? "warn" : "fail") as GateStatus,
        why: `${cls === "refused" ? `source refused automation (${src.f.status})` : `cannot read the source (${src.kind})`}: the quote could not be checked; ${ok ? "checked within 30 days, spot-check the archive-less source" : "and `checked` is missing or older than 30 days"}`,
        votes,
      };
    }
    return { ...base, class: "supported" as ClaimClass, outcome: "pass" as GateStatus, votes };
  });

  const count = (k: ClaimClass) => results.filter((r) => r.class === k).length;
  const failed = results.filter((r) => r.outcome === "fail");
  const warned = results.filter((r) => r.outcome === "warn");
  const status = worst(results.map((r) => r.outcome));
  const metrics = {
    claims: results.length,
    sources: urls.length,
    supported: count("supported"),
    unsupported: count("unsupported"),
    not_both_judges: count("not_both_judges"),
    quote_not_found: count("quote_not_found"),
    source_broken: count("source_broken"),
    source_unverifiable: count("source_unverifiable"),
    judges: judges.slice(0, 2).map((j) => `${j.id}(${j.family})`).join(", "),
  };
  const details = { archive_dir: opts.archiveDir ?? null, claims: results };
  const parts = [`${count("supported")}/${results.length} supported by both judges`];
  if (failed.length) parts.push(`${failed.length} failing: ${failed.slice(0, 5).map((r) => `${r.id} (${r.class})`).join(", ")}${failed.length > 5 ? ", …" : ""}`);
  if (warned.length) parts.push(`${warned.length} unverifiable sources accepted with a fresh check date`);
  return agate(id, status, parts.join("; "), metrics, details);
}

// ---------------------------------------------------------------------------------------------
// claim-sweep

export interface SweepOptions {
  /** Most candidate sentences sent to the judges; the rest are listed and the gate warns. */
  maxJudged?: number;
  concurrency?: number;
}

export function sweepCandidates(site: Site, ledger: LedgerClaim[]): { sentence: string; pages: string[]; covered_by: string | null }[] {
  const by = new Map<string, { sentence: string; pages: string[]; covered_by: string | null }>();
  for (const p of htmlPages(site)) {
    for (const s of sentences(p.body)) {
      if (s.length < 25 || !FACT_RE.test(s)) continue;
      const key = normalizeText(s);
      const e = by.get(key);
      if (e) {
        if (!e.pages.includes(p.path)) e.pages.push(p.path);
        continue;
      }
      by.set(key, { sentence: s.slice(0, 500), pages: [p.path], covered_by: coveredBy(s, ledger) });
    }
  }
  return [...by.values()];
}

export async function claimSweepGate(site: Site | null, dir: string | null, judges: Judge[], opts: SweepOptions = {}, why = "no site to check"): Promise<Gate> {
  const id = "claim-sweep";
  if (!site) return agate(id, "fail", `cannot run: ${why}`);
  const pair = judgePairProblem(judges);
  if (pair) return agate(id, "fail", `cannot run: ${pair}`);
  const ledger = dir ? readLedger(dir) : { claims: [], error: "no clean checkout" };
  const candidates = sweepCandidates(site, ledger.claims);
  const open = candidates.filter((c) => !c.covered_by);
  const max = opts.maxJudged ?? 80;
  const judged = open.slice(0, max);
  const verdicts = await mapLimit(judged, opts.concurrency ?? 4, async (c) => {
    const v = await askBoth(
      judges,
      request(
        "claim-sweep",
        "Is this sentence a factual claim about the outside world that a reader would expect to be backed by a public source: a market or usage figure, a fact about a named company, competitor, standard, law or study? Statements about the product's own design, features, plans, prices, targets or how it works are not such claims: answer no for those.",
        { sentence: c.sentence, pages: c.pages },
      ),
    );
    return { ...c, outcome: (v.outcome === "yes" ? "fail" : v.outcome === "split" ? "warn" : "pass") as GateStatus, votes: votesOf(v) };
  });
  const missing = verdicts.filter((v) => v.outcome === "fail");
  const split = verdicts.filter((v) => v.outcome === "warn");
  const unjudged = open.slice(max);
  const statuses: GateStatus[] = verdicts.map((v) => v.outcome);
  if (unjudged.length) statuses.push("warn");
  if (ledger.error) statuses.push("warn");
  const status = worst(statuses);
  const metrics = {
    factual_sentences: candidates.length,
    covered_by_ledger: candidates.length - open.length,
    judged: verdicts.length,
    missing_from_ledger: missing.length,
    judges_split: split.length,
    not_judged: unjudged.length,
  };
  const details = {
    ...(ledger.error ? { ledger_error: ledger.error } : {}),
    missing: missing.map(({ outcome: _o, covered_by: _c, ...r }) => r),
    split: split.map(({ outcome: _o, covered_by: _c, ...r }) => r),
    not_judged: unjudged.map((c) => ({ sentence: c.sentence, pages: c.pages })),
    covered: candidates.filter((c) => c.covered_by).map((c) => ({ sentence: c.sentence.slice(0, 160), claim: c.covered_by })),
  };
  const summary =
    status === "pass"
      ? `${candidates.length} factual sentences: ${candidates.length - open.length} covered by the ledger, ${verdicts.length} judged not to need a source`
      : [
          missing.length ? `${plural(missing.length, "claim")} on the site missing from claims.yaml (both judges)` : "",
          split.length ? `${split.length} the judges split on` : "",
          unjudged.length ? `${unjudged.length} not judged (over the ${max} limit)` : "",
          ledger.error ? `ledger unreadable: ${ledger.error}` : "",
        ]
          .filter(Boolean)
          .join("; ");
  return agate(id, status, summary, metrics, details);
}

// ---------------------------------------------------------------------------------------------
// pricing

export interface CostTier {
  name: string;
  /** Price per period; null for "contact us". */
  price: number | null;
  /** What one customer on this tier costs to serve per period. */
  cost_to_serve: number;
  includes?: string;
}
export interface CostModel {
  currency: string;
  period: string;
  self_host: boolean;
  tiers: CostTier[];
}

/** greenhouse.yaml `cost_model:` (contract v2, assisted pricing gate). */
export function readCostModel(dir: string): { model: CostModel | null; error?: string } {
  const file = join(dir, "greenhouse.yaml");
  if (!existsSync(file)) return { model: null, error: "greenhouse.yaml is missing" };
  let doc: any;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return { model: null, error: `greenhouse.yaml does not parse: ${(e as Error).message.split("\n")[0]}` };
  }
  const cm = doc?.cost_model;
  if (cm === undefined || cm === null) return { model: null, error: "greenhouse.yaml has no cost_model (contract v2: the pricing gate reconciles the pricing content with it)" };
  const errs: string[] = [];
  if (typeof cm !== "object" || Array.isArray(cm)) return { model: null, error: "cost_model must be a mapping" };
  for (const k of Object.keys(cm)) if (!["currency", "period", "self_host", "tiers"].includes(k)) errs.push(`cost_model: unknown key ${k}`);
  if (cm.currency !== undefined && !/^[A-Z]{3}$/.test(String(cm.currency))) errs.push("cost_model.currency must be a 3-letter code, e.g. USD");
  if (cm.period !== undefined && !["month", "year"].includes(cm.period)) errs.push("cost_model.period must be month or year");
  if (cm.self_host !== undefined && typeof cm.self_host !== "boolean") errs.push("cost_model.self_host must be true or false");
  if (!Array.isArray(cm.tiers) || cm.tiers.length === 0) errs.push("cost_model.tiers must list at least one tier");
  const tiers: CostTier[] = [];
  for (const [i, t] of (Array.isArray(cm.tiers) ? cm.tiers : []).entries()) {
    const at = `cost_model.tiers[${i}]`;
    if (!t || typeof t !== "object") {
      errs.push(`${at} must be a mapping`);
      continue;
    }
    for (const k of Object.keys(t)) if (!["name", "price", "cost_to_serve", "includes"].includes(k)) errs.push(`${at}: unknown key ${k}`);
    if (typeof t.name !== "string" || !t.name.trim()) errs.push(`${at}.name is required`);
    if (!(t.price === null || (typeof t.price === "number" && t.price >= 0))) errs.push(`${at}.price must be a number >= 0, or null for "contact us"`);
    if (!(typeof t.cost_to_serve === "number" && t.cost_to_serve >= 0)) errs.push(`${at}.cost_to_serve must be a number >= 0`);
    if (t.includes !== undefined && typeof t.includes !== "string") errs.push(`${at}.includes must be text`);
    tiers.push({ name: String(t.name ?? ""), price: t.price ?? null, cost_to_serve: Number(t.cost_to_serve ?? 0), ...(typeof t.includes === "string" ? { includes: t.includes } : {}) });
  }
  if (errs.length) return { model: null, error: errs.join("; ") };
  return { model: { currency: cm.currency ?? "USD", period: cm.period ?? "month", self_host: cm.self_host ?? false, tiers } };
}

export async function pricingGate(site: Site | null, dir: string | null, content: ContentMap | null, judges: Judge[], why = "no site to check"): Promise<Gate> {
  const id = "pricing";
  if (!site) return agate(id, "fail", `cannot run: ${why}`);
  if (!dir) return agate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  const pair = judgePairProblem(judges);
  if (pair) return agate(id, "fail", `cannot run: ${pair}`);
  const cm = readCostModel(dir);
  if (!cm.model) return agate(id, "fail", `cannot run: ${cm.error}`);
  const ref = content?.refs.find((r) => r.key === "pricing");
  const path = ref?.path ?? "/pricing/";
  let html = site.pages.get(path)?.body;
  if (html === undefined) {
    try {
      const p = await fetchPage(site.base, path);
      if (p.status === 200) html = p.body;
    } catch {
      /* reported below */
    }
  }
  if (html === undefined) return agate(id, "fail", `cannot run: pricing content ${path} did not load`);
  const section = ref?.anchor ? elementById(html, ref.anchor) : html;
  if (section === null) return agate(id, "fail", `cannot run: #${ref?.anchor} is not on ${path}`);
  const text = visibleText(section);
  const amounts = moneyAmounts(text);
  const problems: string[] = [];
  const tiers = cm.model.tiers.map((t) => {
    const named = new RegExp(`(^|[^\\p{L}\\p{N}])${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(text);
    const priced =
      t.price === null
        ? /\b(contact|custom|talk to|get a quote|quote)\b/i.test(text)
        : t.price === 0
          ? amounts.includes(0) || /\bfree\b/i.test(text)
          : amounts.includes(t.price);
    if (!named) problems.push(`tier "${t.name}" is not on the pricing content`);
    if (!priced) problems.push(`tier "${t.name}": price ${t.price === null ? "contact us" : t.price} is not on the pricing content`);
    const belowCost = t.price !== null && t.price > 0 && t.cost_to_serve > t.price;
    if (belowCost) problems.push(`tier "${t.name}" sells below its cost to serve (${t.price} < ${t.cost_to_serve} ${cm.model!.currency}/${cm.model!.period})`);
    return { name: t.name, price: t.price, cost_to_serve: t.cost_to_serve, margin: t.price === null ? null : Math.round((t.price - t.cost_to_serve) * 100) / 100, on_page: named, price_on_page: priced };
  });
  const selfHostShown = /self[- ]?host/i.test(text);
  if (cm.model.self_host && !selfHostShown) problems.push("cost_model.self_host is true but the pricing content does not show the self-hosting path");
  const known = new Set(cm.model.tiers.map((t) => t.price).filter((p): p is number => p !== null));
  const unreconciled = [...new Set(amounts.filter((a) => !known.has(a)))];
  const verdict = await askBoth(
    judges,
    request(
      "pricing",
      "Does the pricing text contradict the cost model: a tier, price, usage limit, inclusion, discount or self-hosting promise that the cost model does not contain or that would be sold below its cost to serve? Amounts not in the cost model are listed in unreconciled_amounts; answer yes if any of them is a price the cost model cannot support.",
      { pricing_text: text.slice(0, 6000), cost_model: cm.model, unreconciled_amounts: unreconciled },
    ),
  );
  const judged: GateStatus = verdict.outcome === "yes" ? "fail" : verdict.outcome === "split" ? "warn" : "pass";
  const status = problems.length ? "fail" : judged;
  const metrics = { tiers: tiers.length, problems: problems.length, unreconciled_amounts: unreconciled.length, judges_contradiction: verdict.outcome };
  const details = { content: ref?.raw ?? path, cost_model: cm.model, tiers, self_host_shown: selfHostShown, unreconciled_amounts: unreconciled, problems, votes: votesOf(verdict) };
  const summary = problems.length
    ? `${plural(problems.length, "problem")}: ${problems.slice(0, 3).join("; ")}`
    : judged === "fail"
      ? "both judges: the pricing content contradicts the cost model"
      : judged === "warn"
        ? `tiers and prices match the cost model; the judges split on a contradiction`
        : `${plural(tiers.length, "tier")} on ${ref?.raw ?? path} match the cost model, none below cost; judges found no contradiction`;
  return agate(id, status, summary, metrics, details);
}

// ---------------------------------------------------------------------------------------------
// social-proof

export async function socialProofGate(site: Site | null, dir: string | null, judges: Judge[], why = "no site to check"): Promise<Gate> {
  const id = "social-proof";
  if (!site) return agate(id, "fail", `cannot run: ${why}`);
  const pair = judgePairProblem(judges);
  if (pair) return agate(id, "fail", `cannot run: ${pair}`);
  const ledger = dir ? readLedger(dir).claims : [];
  const found: { kind: string; text: string; page: string; backed_by: string | null }[] = [];
  const seen = new Set<string>();
  for (const p of htmlPages(site))
    for (const c of socialProofCandidates(p.body)) {
      const k = normalizeText(c.text);
      if (seen.has(k)) continue;
      seen.add(k);
      found.push({ ...c, page: p.path, backed_by: coveredBy(c.text, ledger) });
    }
  const open = found.filter((f) => !f.backed_by).slice(0, 60);
  const judged = await mapLimit(open, 4, async (c) => {
    const v = await askBoth(
      judges,
      request(
        "social-proof",
        "This product is a new, unlaunched seed project with no customers yet. Is this presented to visitors as real social proof for the product (a testimonial, a customer or partner logo, a user or customer count, a rating, a press mention) rather than a clearly labelled example, a sourced fact about a third party, or a description of the product?",
        { kind: c.kind, text: c.text, page: c.page },
      ),
    );
    return { ...c, outcome: (v.outcome === "yes" ? "fail" : v.outcome === "split" ? "warn" : "pass") as GateStatus, votes: votesOf(v) };
  });
  const invented = judged.filter((j) => j.outcome === "fail");
  const split = judged.filter((j) => j.outcome === "warn");
  const status = worst(judged.map((j) => j.outcome));
  const metrics = { candidates: found.length, backed_by_ledger: found.length - found.filter((f) => !f.backed_by).length, invented: invented.length, judges_split: split.length };
  const details = { invented, split, cleared: judged.filter((j) => j.outcome === "pass"), backed: found.filter((f) => f.backed_by) };
  const summary =
    status === "fail"
      ? `invented social proof (both judges): ${invented.slice(0, 3).map((i) => `${i.page} "${i.text.slice(0, 60)}"`).join("; ")}`
      : status === "warn"
        ? `${split.length} possible social proof the judges split on; for the panel`
        : found.length
          ? `${plural(found.length, "candidate")} checked: none presented as real social proof`
          : "no testimonials, logos, customer counts, ratings or press mentions found";
  return agate(id, status, summary, metrics, details);
}

// ---------------------------------------------------------------------------------------------
// reviewer-instruction

export const MACHINE_FILES = ["/llms.txt", "/llms-full.txt", "/robots.txt", "/ai.txt", "/humans.txt"];

export async function reviewerInstructionGate(site: Site | null, judges: Judge[], hidden: Map<string, HiddenSource[]> = new Map(), why = "no site to check"): Promise<Gate> {
  const id = "reviewer-instruction";
  if (!site) return agate(id, "fail", `cannot run: ${why}`);
  const pair = judgePairProblem(judges);
  if (pair) return agate(id, "fail", `cannot run: ${pair}`);
  const strong: { page: string; where: string; pattern?: string; text: string }[] = [];
  const weak: { page: string; where: string; pattern?: string; text: string }[] = [];
  const docs: { path: string; raw: string }[] = htmlPages(site).map((p) => ({ path: p.path, raw: p.body }));
  for (const f of MACHINE_FILES) {
    try {
      const p = await fetchPage(site.base, f);
      if (p.status === 200 && !p.isHtml && p.body) docs.push({ path: f, raw: p.body });
    } catch {
      /* absent */
    }
  }
  const seenWeak = new Set<string>();
  for (const d of docs) {
    const raw = d.path.endsWith(".txt") ? `<pre><!--${d.raw.replace(/-->/g, "")}--></pre>` : d.raw; // machine files: nobody reads them as a page
    const c = instructionCandidates(raw, hidden.get(d.path) ?? []);
    for (const s of c.strong) strong.push({ page: d.path, ...s, where: d.path.endsWith(".txt") ? d.path : s.where });
    for (const w of c.weak) {
      const key = normalizeText(w.text);
      if (seenWeak.has(key)) continue; // the same meta description on every page is judged once
      seenWeak.add(key);
      weak.push({ page: d.path, ...w, where: d.path.endsWith(".txt") ? d.path : w.where });
    }
  }
  const judged = await mapLimit(weak.slice(0, 40), 4, async (w) => {
    const v = await askBoth(
      judges,
      request(
        "reviewer-instruction",
        "Is this text addressed to an AI reviewer, judge, grader or language model evaluating the site (telling it what to conclude, how to score, or what to ignore), rather than written for the site's human visitors? Text that explains the product, or that discusses AI or prompt injection as a topic, is not.",
        { where: w.where, page: w.page, text: w.text },
      ),
    );
    return { ...w, outcome: (v.outcome === "yes" ? "fail" : v.outcome === "split" ? "warn" : "pass") as GateStatus, votes: votesOf(v) };
  });
  const statuses: GateStatus[] = [...judged.map((j) => j.outcome), ...(strong.length ? (["fail"] as GateStatus[]) : [])];
  const status = worst(statuses);
  const aimed = judged.filter((j) => j.outcome === "fail");
  const split = judged.filter((j) => j.outcome === "warn");
  const metrics = { documents: docs.length, hidden_instructions: strong.length, candidates: weak.length, aimed_at_reviewers: aimed.length, judges_split: split.length };
  const details = { hidden_instructions: strong.slice(0, 50), aimed_at_reviewers: aimed, split, cleared: judged.filter((j) => j.outcome === "pass") };
  const summary = strong.length
    ? `hidden instruction to reviewers or models: ${strong.slice(0, 2).map((s) => `${s.page} ${s.where} (${s.pattern})`).join("; ")}`
    : aimed.length
      ? `text aimed at reviewers (both judges): ${aimed.slice(0, 2).map((a) => `${a.page} "${a.text.slice(0, 60)}"`).join("; ")}`
      : split.length
        ? `${split.length} passage(s) the judges split on; for the panel`
        : `${docs.length} documents scanned (pages and machine-readable files): no text aimed at reviewers`;
  return agate(id, status, summary, metrics, details);
}

// ---------------------------------------------------------------------------------------------
// hidden-text

export const CRAWLER_USER_AGENTS: Record<string, string> = {
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
};
/** Hidden text this long or shorter, clipped or off-screen, is a screen-reader label, not a problem. */
export const SR_ONLY_MAX_CHARS = 80;
/** Visible-text similarity under which a crawler is served different content. */
export const CLOAKING_MIN_SIMILARITY = 0.9;

export interface HiddenItem {
  selector: string;
  reason: "tiny-font" | "low-contrast" | "off-screen" | "clipped";
  chars: number;
  text: string;
}

/** In the page: text-bearing elements a person cannot see although they are laid out. */
function scanHidden(srOnlyMax: number): HiddenItem[] {
  const parse = (c: string): [number, number, number, number] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el: Element): number[] | null => {
    for (let a: Element | null = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const sel = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    return tag + [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
  };
  const out: HiddenItem[] = [];
  const W = document.documentElement.scrollWidth;
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("script, style, noscript, template, svg, select, option, head")) continue;
    let own = "";
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent ?? "";
    own = own.replace(/\s+/g, " ").trim();
    if (own.length < 2) continue;
    const rects = el.getClientRects();
    if (rects.length === 0) continue; // display:none or not rendered
    const s = getComputedStyle(el);
    if (s.visibility !== "visible") continue;
    const r = el.getBoundingClientRect();
    const left = r.left + scrollX;
    const top = r.top + scrollY;
    let reason: HiddenItem["reason"] | null = null;
    if (r.right + scrollX <= 0 || left >= W || r.bottom + scrollY <= 0) reason = "off-screen";
    else if (r.width <= 2 || r.height <= 2) reason = "clipped";
    else if (parseFloat(s.fontSize) < 6) reason = "tiny-font";
    else {
      const fg = parse(s.color);
      const bg = bgOf(el);
      if (fg && bg) {
        if (fg[3] < 0.1) reason = "low-contrast";
        else {
          const a = lum(fg);
          const b = lum(bg);
          const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          if (ratio < 1.25) reason = "low-contrast";
        }
      }
    }
    void top;
    if (!reason) continue;
    if ((reason === "off-screen" || reason === "clipped") && own.length <= srOnlyMax) continue;
    out.push({ selector: sel(el), reason, chars: own.length, text: own.slice(0, 300) });
  }
  return out;
}

function wordSet(s: string): Set<string> {
  return contentTokens(s);
}

export interface HiddenTextOptions {
  /** Pages scanned in the browser (default 30). */
  maxPages?: number;
  /** Test hook: fetches a path with a given user agent. */
  fetchAs?: (url: string, userAgent: string) => Promise<{ status: number; body: string }>;
}

async function defaultFetchAs(url: string, userAgent: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "user-agent": userAgent } });
  return { status: res.status, body: await res.text() };
}

export async function hiddenTextGate(
  browser: Browser | null,
  site: Site | null,
  start: readonly string[],
  judges: Judge[],
  opts: HiddenTextOptions = {},
  why = "no site to check",
): Promise<{ gate: Gate; hidden: Map<string, HiddenSource[]> }> {
  const id = "hidden-text";
  const hidden = new Map<string, HiddenSource[]>();
  const fail = (s: string) => ({ gate: agate(id, "fail", `cannot run: ${s}`), hidden });
  if (!site) return fail(why);
  if (!browser) return fail(why);
  const pair = judgePairProblem(judges);
  if (pair) return fail(pair);

  // 1. Cloaking: the same start pages fetched as a browser and as crawlers.
  const fetchAs = opts.fetchAs ?? defaultFetchAs;
  const cloaking: { path: string; crawler: string; similarity: number; status: number }[] = [];
  for (const path of start) {
    const url = new URL(path, site.base).toString();
    let human: { status: number; body: string };
    try {
      human = await fetchAs(url, BROWSER_USER_AGENT);
    } catch {
      continue;
    }
    const H = wordSet(visibleText(human.body));
    for (const [name, ua] of Object.entries(CRAWLER_USER_AGENTS)) {
      try {
        const bot = await fetchAs(url, ua);
        const B = wordSet(visibleText(bot.body));
        let inter = 0;
        for (const w of H) if (B.has(w)) inter++;
        const sim = H.size + B.size === 0 ? 1 : inter / (H.size + B.size - inter);
        if (sim < CLOAKING_MIN_SIMILARITY || bot.status !== human.status) cloaking.push({ path, crawler: name, similarity: Math.round(sim * 1000) / 1000, status: bot.status });
      } catch {
        /* a crawler fetch that errors is not cloaking */
      }
    }
  }

  // 2. Text laid out but invisible to people, on each page.
  const items: (HiddenItem & { page: string })[] = [];
  const pages = htmlPages(site).slice(0, opts.maxPages ?? 30);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await ctx.newPage();
    for (const p of pages) {
      try {
        await page.goto(new URL(p.path, site.base).toString(), { waitUntil: "load", timeout: 30_000 });
        await page.waitForTimeout(300);
        const found = await page.evaluate(scanHidden, SR_ONLY_MAX_CHARS);
        for (const f of found) items.push({ ...f, page: p.path });
        if (found.length) hidden.set(p.path, found.map((f) => ({ where: `hidden element ${f.selector} (${f.reason})`, text: f.text })));
      } catch (e) {
        items.push({ page: p.path, selector: "(page)", reason: "off-screen", chars: 0, text: `could not scan: ${(e as Error).message.split("\n")[0]}` });
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const toJudge = items.filter((i) => i.chars > 0).slice(0, 20);
  const judged = await mapLimit(toJudge, 4, async (i) => {
    const v = await askBoth(
      judges,
      request(
        "hidden-text",
        "This text is on the page but a sighted visitor cannot see it (the reason says how it is hidden). Is it there to be read by machines (search engines, AI crawlers or AI reviewers) rather than being an accessibility aid, a decorative effect or ordinary interface text?",
        { page: i.page, reason: i.reason, chars: i.chars, text: i.text },
      ),
    );
    return { ...i, outcome: (v.outcome === "yes" ? "fail" : v.outcome === "split" ? "warn" : "pass") as GateStatus, votes: votesOf(v) };
  });
  const statuses: GateStatus[] = [...judged.map((j) => j.outcome), ...(cloaking.length ? (["fail"] as GateStatus[]) : [])];
  if (items.length > toJudge.length) statuses.push("warn");
  const status = worst(statuses);
  const forMachines = judged.filter((j) => j.outcome === "fail");
  const split = judged.filter((j) => j.outcome === "warn");
  const metrics = { pages: pages.length, cloaked_pages: new Set(cloaking.map((c) => c.path)).size, hidden_elements: items.length, hidden_for_machines: forMachines.length, judges_split: split.length };
  const details = { crawlers: Object.keys(CRAWLER_USER_AGENTS), cloaking, hidden_for_machines: forMachines, split, cleared: judged.filter((j) => j.outcome === "pass"), sr_only_max_chars: SR_ONLY_MAX_CHARS };
  const summary = cloaking.length
    ? `crawlers are served different content: ${cloaking.slice(0, 3).map((c) => `${c.path} as ${c.crawler} (similarity ${c.similarity})`).join("; ")}`
    : forMachines.length
      ? `text hidden from people for machines (both judges): ${forMachines.slice(0, 2).map((f) => `${f.page} ${f.selector} (${f.reason})`).join("; ")}`
      : split.length
        ? `${split.length} hidden passage(s) the judges split on; for the panel`
        : `${pages.length} pages: no cloaking, ${items.length ? `${plural(items.length, "hidden element")} judged legitimate` : "no hidden text beyond screen-reader labels"}`;
  return { gate: agate(id, status, summary, metrics, details), hidden };
}
