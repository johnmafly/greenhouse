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
import { parseContentRef } from "./content.ts";
import type { ContentMap } from "./content.ts";
import { visibleText } from "./html.ts";
import { askBoth, judgePairProblem, request } from "./judge.ts";
import { MOCK_FILE, hasSampleNote, isListedMock, readMockListing } from "./mock.ts";
import type { MockListing } from "./mock.ts";
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

// Bot-protection interstitials served with a 2xx status instead of the source. Each marker is
// specific to one vendor's challenge page, and is only consulted when the quote is not found, so a
// real article that loads a vendor's script still passes when it carries the quote.
const CHALLENGE_MARKERS: [string, RegExp][] = [
  ["Imperva", /Pardon Our Interruption|_Incapsula_Resource|\bincap_ses_/i],
  ["Cloudflare", /<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare|\/cdn-cgi\/challenge-platform\/|\bcf-chl-/i],
  ["DataDome", /captcha-delivery\.com/i],
  ["HUMAN", /px-captcha|_pxCaptcha/],
  ["AWS WAF", /awsWafCookieDomainList|AwsWafIntegration/],
  ["Akamai", /<title>\s*Access Denied\s*<\/title>[\s\S]*errors\.edgesuite\.net/i],
];

/** The vendor whose bot challenge this HTML body is, or null. */
export function challengeVendor(html: string): string | null {
  for (const [vendor, re] of CHALLENGE_MARKERS) if (re.test(html)) return vendor;
  return null;
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
  const fetched = new Map<string, { f: SourceFetch; text: string | null; kind: string; challenge: string | null; archive: ArchiveEntry }>();
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
      challenge: st.kind === "html" && f.body ? challengeVendor(f.body.toString("utf8")) : null,
      archive: { url, final_url: f.finalUrl, status: f.status, content_type: f.contentType, fetched_at: new Date().toISOString(), sha256, file, bytes: f.body?.length ?? 0 },
    });
  });
  if (opts.archiveDir)
    writeFileSync(join(opts.archiveDir, "index.json"), JSON.stringify(urls.map((u) => fetched.get(u)!.archive), null, 2) + "\n");

  const results = await mapLimit(ledger.claims, opts.concurrency ?? 4, async (c) => {
    const src = fetched.get(c.source_url)!;
    let cls = classifyStatus(src.f.status);
    let quote_found: boolean | null = null;
    let challenge: string | null = null;
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
      // A bot challenge in place of the source: refused automation, not a missing quote.
      if (quote_found === false && src.challenge) {
        quote_found = null;
        cls = "refused";
        challenge = src.challenge;
      }
    }
    const base = {
      id: c.id,
      source_url: c.source_url,
      status: src.f.status,
      archived: src.archive.file,
      quote_found,
      ...(verifiedBy ? { quote_verified_in: verifiedBy } : {}),
      ...(challenge ? { challenge } : {}),
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
        why: `${challenge ? `source answered with a bot challenge (${challenge}, ${src.f.status})` : cls === "refused" ? `source refused automation (${src.f.status})` : `cannot read the source (${src.kind})`}: the quote could not be checked; ${ok ? "checked within 30 days, spot-check the archive-less source" : "and `checked` is missing or older than 30 days"}`,
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

/**
 * Factual-looking sentences on the site, each with the ledger claim that covers it. Decision 0008:
 * a sentence whose every number is a sample figure MOCK_FIGURES.md lists for its page, on a page
 * that carries the sample note, is covered by MOCK_FIGURES.md (the mock-figures gate checks the
 * note and the listing), not an outside claim missing from claims.yaml.
 */
export function sweepCandidates(site: Site, ledger: LedgerClaim[], mock: MockListing | null = null): { sentence: string; pages: string[]; covered_by: string | null }[] {
  const by = new Map<string, { sentence: string; pages: string[]; covered_by: string | null }>();
  for (const p of htmlPages(site)) {
    const note = hasSampleNote(visibleText(p.body));
    for (const s of sentences(p.body)) {
      if (s.length < 25 || !FACT_RE.test(s)) continue;
      const key = normalizeText(s);
      const e = by.get(key);
      if (e) {
        if (!e.pages.includes(p.path)) e.pages.push(p.path);
        continue;
      }
      by.set(key, { sentence: s.slice(0, 500), pages: [p.path], covered_by: coveredBy(s, ledger) ?? (isListedMock(s, p.path, note, mock) ? MOCK_FILE : null) });
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
  const candidates = sweepCandidates(site, ledger.claims, readMockListing(dir));
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

export interface CostOverage {
  /** The billing unit after "per_", e.g. "1000" for overage_per_1000. */
  unit: string;
  /** What the customer pays per unit over the included amount; null when there is no overage. */
  price: number | null;
  /** What that unit costs us to serve; null when there is no overage. */
  cost: number | null;
}
export interface CostTier {
  name: string;
  /** Price per period; null for "contact us". */
  price: number | null;
  /** What one customer on this tier costs to serve per period. */
  cost_to_serve: number;
  includes?: string;
  serves?: string;
  edition?: string;
  kind?: "self-hosted" | "cloud";
  /** The price is a "from" price. */
  price_is_floor?: boolean;
  /** price - cost_to_serve, when the package states it. */
  margin?: number;
  /** Declared below cost. Only a free tier may be, and only with a below_cost_reason. */
  below_cost?: boolean;
  below_cost_reason?: string;
  /** The cost_to_serve broken down; must add up to it. */
  cost_lines?: Record<string, number>;
  overages: CostOverage[];
  /** included_* amounts and any other numeric fact about the tier (e.g. cohorts_watched). */
  limits: Record<string, number | null>;
}
export interface SelfHosting {
  /** Site path of the self-hosting guide. */
  path: string;
  /** Site path (optionally #anchor) where the costs of running it are shown. */
  costs_page?: string;
  price: number;
  cost_to_us: number;
  paid_by?: string;
  below_cost?: boolean;
  below_cost_reason?: string;
  reference_month?: Record<string, number>;
}
export interface CostSource {
  id: string;
  /** A claims.yaml id that already sources this figure. */
  claim?: string;
  source_url?: string;
  quote?: string;
  checked?: string;
}
export interface CostModel {
  currency: string;
  period: string;
  self_host: boolean;
  self_hosting?: SelfHosting;
  /** Where the prices are shown; overrides content.pricing. */
  pricing_page?: string;
  /** Repo path of the script or sheet that computes the figures. */
  workings?: string;
  sources?: CostSource[];
  /** The inputs the figures rest on: a value and where it comes from ("site: /own/", "ours: ..."). */
  assumptions?: Record<string, { value: number | boolean | string; basis: string }>;
  tiers: CostTier[];
}

const COST_KEYS = ["currency", "period", "self_host", "self_hosting", "pricing_page", "workings", "sources", "assumptions", "tiers"];
const TIER_KEYS = ["name", "price", "cost_to_serve", "includes", "serves", "edition", "kind", "price_is_floor", "margin", "below_cost", "below_cost_reason", "cost_lines"];
const SELF_HOSTING_KEYS = ["path", "costs_page", "price", "cost_to_us", "paid_by", "below_cost", "below_cost_reason", "reference_month"];
const SOURCE_KEYS = ["id", "claim", "source_url", "quote", "checked"];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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
  if (!isMap(cm)) return { model: null, error: "cost_model must be a mapping" };
  for (const k of Object.keys(cm)) if (!COST_KEYS.includes(k)) errs.push(`cost_model: unknown key ${k}`);
  if (cm.currency !== undefined && !/^[A-Z]{3}$/.test(String(cm.currency))) errs.push("cost_model.currency must be a 3-letter code, e.g. USD");
  if (cm.period !== undefined && !["month", "year"].includes(cm.period as string)) errs.push("cost_model.period must be month or year");
  if (cm.self_host !== undefined && typeof cm.self_host !== "boolean") errs.push("cost_model.self_host must be true or false");
  if (cm.self_host === false && cm.self_hosting !== undefined) errs.push("cost_model.self_host is false but cost_model.self_hosting is set");
  const sitePath = (at: string, v: unknown): string | undefined => {
    const r = parseContentRef("pricing", v);
    if (r.error) {
      errs.push(r.error.replace(/^content\.pricing/, at));
      return undefined;
    }
    return r.ref!.raw;
  };
  const pricing_page = cm.pricing_page === undefined ? undefined : sitePath("cost_model.pricing_page", cm.pricing_page);
  let workings: string | undefined;
  if (cm.workings !== undefined) {
    const w = cm.workings;
    if (!isText(w) || w.startsWith("/") || w.split(/[\\/]/).includes("..")) errs.push("cost_model.workings must be a path inside the repository, e.g. costs/model.mjs");
    else if (!existsSync(join(dir, w))) errs.push(`cost_model.workings: ${w} is not in the repository`);
    else workings = w;
  }
  const belowDecl = (at: string, o: Record<string, unknown>) => {
    if (o.below_cost !== undefined && typeof o.below_cost !== "boolean") errs.push(`${at}.below_cost must be true or false`);
    if (o.below_cost_reason !== undefined && !isText(o.below_cost_reason)) errs.push(`${at}.below_cost_reason must be text`);
    if (isText(o.below_cost_reason) && o.below_cost !== true) errs.push(`${at}.below_cost_reason is set but below_cost is not true`);
  };
  let self_hosting: SelfHosting | undefined;
  if (cm.self_hosting !== undefined) {
    const s = cm.self_hosting;
    const at = "cost_model.self_hosting";
    if (!isMap(s)) errs.push(`${at} must be a mapping`);
    else {
      for (const k of Object.keys(s)) if (!SELF_HOSTING_KEYS.includes(k)) errs.push(`${at}: unknown key ${k}`);
      const path = sitePath(`${at}.path`, s.path);
      if (path?.includes("#")) errs.push(`${at}.path must be a page, without #anchor`);
      const costs_page = s.costs_page === undefined ? undefined : sitePath(`${at}.costs_page`, s.costs_page);
      if (!(isNum(s.price) && s.price >= 0)) errs.push(`${at}.price must be a number >= 0`);
      if (!(isNum(s.cost_to_us) && s.cost_to_us >= 0)) errs.push(`${at}.cost_to_us must be a number >= 0`);
      if (s.paid_by !== undefined && !isText(s.paid_by)) errs.push(`${at}.paid_by must be text`);
      belowDecl(at, s);
      if (s.reference_month !== undefined && !(isMap(s.reference_month) && Object.values(s.reference_month).every(isNum)))
        errs.push(`${at}.reference_month must map names to numbers`);
      self_hosting = {
        path: path ?? "",
        ...(costs_page ? { costs_page } : {}),
        price: Number(s.price ?? 0),
        cost_to_us: Number(s.cost_to_us ?? 0),
        ...(isText(s.paid_by) ? { paid_by: s.paid_by } : {}),
        ...(typeof s.below_cost === "boolean" ? { below_cost: s.below_cost } : {}),
        ...(isText(s.below_cost_reason) ? { below_cost_reason: s.below_cost_reason } : {}),
        ...(isMap(s.reference_month) ? { reference_month: s.reference_month as Record<string, number> } : {}),
      };
    }
  }
  let sources: CostSource[] | undefined;
  if (cm.sources !== undefined) {
    if (!Array.isArray(cm.sources)) errs.push("cost_model.sources must be a list");
    else {
      sources = [];
      const ids = new Set<string>();
      const ledger = cm.sources.some((s: any) => isMap(s) && s.claim !== undefined) ? readLedger(dir) : null;
      const ledgerIds = new Set(ledger?.claims.map((c) => c.id) ?? []);
      for (const [i, s] of cm.sources.entries()) {
        const at = `cost_model.sources[${i}]`;
        if (!isMap(s)) {
          errs.push(`${at} must be a mapping`);
          continue;
        }
        for (const k of Object.keys(s)) if (!SOURCE_KEYS.includes(k)) errs.push(`${at}: unknown key ${k}`);
        if (!isText(s.id)) errs.push(`${at}.id is required`);
        else if (ids.has(s.id)) errs.push(`${at}.id ${s.id} is used twice`);
        else ids.add(s.id);
        const checked = s.checked instanceof Date ? s.checked.toISOString().slice(0, 10) : s.checked;
        if (s.claim !== undefined) {
          if (s.source_url !== undefined || s.quote !== undefined) errs.push(`${at}: give either claim or source_url and quote, not both`);
          if (!isText(s.claim)) errs.push(`${at}.claim must be a claims.yaml id`);
          else if (ledger?.error) errs.push(`${at}.claim ${s.claim}: ${ledger.error}`);
          else if (!ledgerIds.has(s.claim)) errs.push(`${at}.claim ${s.claim} is not a claims.yaml id`);
        } else {
          if (!(isText(s.source_url) && /^https?:\/\/\S+$/.test(s.source_url))) errs.push(`${at} needs a claim (a claims.yaml id) or a source_url (http or https)`);
          if (!isText(s.quote)) errs.push(`${at}.quote is required with source_url`);
        }
        if (checked !== undefined && !(typeof checked === "string" && /^\d{4}-\d{2}-\d{2}$/.test(checked))) errs.push(`${at}.checked must be a date, YYYY-MM-DD`);
        sources.push({
          id: String(s.id ?? ""),
          ...(isText(s.claim) ? { claim: s.claim } : {}),
          ...(isText(s.source_url) ? { source_url: s.source_url } : {}),
          ...(isText(s.quote) ? { quote: s.quote } : {}),
          ...(typeof checked === "string" ? { checked } : {}),
        });
      }
    }
  }
  let assumptions: CostModel["assumptions"];
  if (cm.assumptions !== undefined) {
    if (!isMap(cm.assumptions)) errs.push("cost_model.assumptions must map names to { value, basis }");
    else {
      assumptions = {};
      for (const [k, a] of Object.entries(cm.assumptions)) {
        const at = `cost_model.assumptions.${k}`;
        if (!isMap(a)) {
          errs.push(`${at} must be { value, basis }`);
          continue;
        }
        for (const ak of Object.keys(a)) if (!["value", "basis"].includes(ak)) errs.push(`${at}: unknown key ${ak}`);
        if (!(isNum(a.value) || typeof a.value === "boolean" || isText(a.value))) errs.push(`${at}.value must be a number, true/false or text`);
        if (!isText(a.basis)) errs.push(`${at}.basis is required: where the value comes from`);
        assumptions[k] = { value: a.value as number | boolean | string, basis: String(a.basis ?? "") };
      }
    }
  }
  if (!Array.isArray(cm.tiers) || cm.tiers.length === 0) errs.push("cost_model.tiers must list at least one tier");
  const tiers: CostTier[] = [];
  for (const [i, t] of (Array.isArray(cm.tiers) ? cm.tiers : []).entries()) {
    const at = `cost_model.tiers[${i}]`;
    if (!isMap(t)) {
      errs.push(`${at} must be a mapping`);
      continue;
    }
    const overages = new Map<string, CostOverage>();
    const limits: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(t)) {
      if (TIER_KEYS.includes(k)) continue;
      const ov = /^overage_(cost_)?per_([a-z0-9_]+)$/.exec(k);
      if (ov) {
        if (!(v === null || (isNum(v) && v >= 0))) errs.push(`${at}.${k} must be a number >= 0, or null for no overage`);
        const o = overages.get(ov[2]) ?? { unit: ov[2], price: null, cost: null };
        if (ov[1]) o.cost = isNum(v) ? v : null;
        else o.price = isNum(v) ? v : null;
        overages.set(ov[2], o);
        continue;
      }
      // Any other key is a numeric fact about the tier (included_sessions, cohorts_watched, ...).
      if (/^[a-z][a-z0-9_]*$/.test(k) && (v === null || isNum(v))) limits[k] = v as number | null;
      else errs.push(`${at}: unknown key ${k} (extra tier facts must be numbers)`);
    }
    for (const u of overages.keys())
      if (!(`overage_per_${u}` in t && `overage_cost_per_${u}` in t)) errs.push(`${at}: overage_per_${u} and overage_cost_per_${u} go together`);
    for (const o of overages.values()) if ((o.price === null) !== (o.cost === null)) errs.push(`${at}: overage_per_${o.unit} and overage_cost_per_${o.unit} must both be numbers or both null`);
    if (!isText(t.name)) errs.push(`${at}.name is required`);
    if (!(t.price === null || (isNum(t.price) && t.price >= 0))) errs.push(`${at}.price must be a number >= 0, or null for "contact us"`);
    if (!(isNum(t.cost_to_serve) && t.cost_to_serve >= 0)) errs.push(`${at}.cost_to_serve must be a number >= 0`);
    for (const k of ["includes", "serves", "edition"]) if (t[k] !== undefined && !isText(t[k])) errs.push(`${at}.${k} must be text`);
    if (t.kind !== undefined && !["self-hosted", "cloud"].includes(t.kind as string)) errs.push(`${at}.kind must be self-hosted or cloud`);
    if (t.price_is_floor !== undefined && typeof t.price_is_floor !== "boolean") errs.push(`${at}.price_is_floor must be true or false`);
    if (t.margin !== undefined && !isNum(t.margin)) errs.push(`${at}.margin must be a number`);
    belowDecl(at, t);
    if (t.cost_lines !== undefined && !(isMap(t.cost_lines) && Object.values(t.cost_lines).every((v) => isNum(v) && v >= 0)))
      errs.push(`${at}.cost_lines must map names to numbers >= 0`);
    tiers.push({
      name: String(t.name ?? ""),
      price: (t.price as number | null | undefined) ?? null,
      cost_to_serve: Number(t.cost_to_serve ?? 0),
      ...(isText(t.includes) ? { includes: t.includes } : {}),
      ...(isText(t.serves) ? { serves: t.serves } : {}),
      ...(isText(t.edition) ? { edition: t.edition } : {}),
      ...(t.kind === "self-hosted" || t.kind === "cloud" ? { kind: t.kind } : {}),
      ...(typeof t.price_is_floor === "boolean" ? { price_is_floor: t.price_is_floor } : {}),
      ...(isNum(t.margin) ? { margin: t.margin } : {}),
      ...(typeof t.below_cost === "boolean" ? { below_cost: t.below_cost } : {}),
      ...(isText(t.below_cost_reason) ? { below_cost_reason: t.below_cost_reason } : {}),
      ...(isMap(t.cost_lines) ? { cost_lines: t.cost_lines as Record<string, number> } : {}),
      overages: [...overages.values()],
      limits,
    });
  }
  if (errs.length) return { model: null, error: errs.join("; ") };
  return {
    model: {
      currency: (cm.currency as string) ?? "USD",
      period: (cm.period as string) ?? "month",
      self_host: (cm.self_host as boolean | undefined) ?? self_hosting !== undefined,
      ...(self_hosting ? { self_hosting } : {}),
      ...(pricing_page ? { pricing_page } : {}),
      ...(workings ? { workings } : {}),
      ...(sources ? { sources } : {}),
      ...(assumptions ? { assumptions } : {}),
      tiers,
    },
  };
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * What the cost model itself gets wrong, before any page is read: tiers below their cost to serve
 * (a free tier only with below_cost and a reason), overages below their unit cost, stated margins
 * and cost lines that do not add up.
 */
export function costModelProblems(m: CostModel): { problems: string[]; acquisition: { name: string; cost: number; reason: string }[] } {
  const problems: string[] = [];
  const acquisition: { name: string; cost: number; reason: string }[] = [];
  const unit = `${m.currency}/${m.period}`;
  const belowRule = (label: string, price: number, cost: number, o: { below_cost?: boolean; below_cost_reason?: string }) => {
    const below = cents(cost) > cents(price);
    if (below && price > 0) problems.push(`${label} sells below its cost to serve (${price} < ${cost} ${unit})${o.below_cost ? "; only a free tier may be declared below cost" : ""}`);
    else if (below && o.below_cost === true && o.below_cost_reason) acquisition.push({ name: label, cost, reason: o.below_cost_reason });
    else if (below) problems.push(`${label} is free but costs ${cost} ${unit} to serve; declare below_cost: true with a below_cost_reason (an acquisition cost)`);
    else if (o.below_cost === true) problems.push(`${label} declares below_cost: true but its price ${price} covers its cost to serve ${cost}`);
  };
  for (const t of m.tiers) {
    const label = `tier "${t.name}"`;
    if (t.price !== null) belowRule(label, t.price, t.cost_to_serve, t);
    else if (t.below_cost === true) problems.push(`${label} has no fixed price and cannot be declared below cost`);
    for (const o of t.overages)
      if (o.price !== null && o.cost !== null && o.cost > o.price) problems.push(`${label}: overage per ${o.unit} sells below its cost (${o.price} < ${o.cost} ${m.currency})`);
    if (t.margin !== undefined && t.price !== null && Math.abs(t.margin - (t.price - t.cost_to_serve)) > 0.011)
      problems.push(`${label}: margin ${t.margin} is not price - cost_to_serve (${cents(t.price - t.cost_to_serve)})`);
    if (t.cost_lines) {
      const lines = Object.values(t.cost_lines);
      const sum = lines.reduce((a, b) => a + b, 0);
      // Each line is rounded to the cent, so allow half a cent of drift per line.
      if (Math.abs(sum - t.cost_to_serve) > 0.005 * lines.length + 0.005)
        problems.push(`${label}: cost_lines add up to ${cents(sum)}, not cost_to_serve ${t.cost_to_serve}`);
    }
  }
  if (m.self_hosting) belowRule("self-hosting", m.self_hosting.price, m.self_hosting.cost_to_us, m.self_hosting);
  return { problems, acquisition };
}

async function pageText(site: Site, raw: string): Promise<{ text?: string; html?: string; error?: string }> {
  const r = parseContentRef("pricing", raw);
  if (!r.ref) return { error: `${raw} is not a site path` };
  let html = site.pages.get(r.ref.path)?.body;
  if (html === undefined) {
    try {
      const p = await fetchPage(site.base, r.ref.path);
      if (p.status === 200) html = p.body;
      else return { error: `${r.ref.path} answers HTTP ${p.status}` };
    } catch (e) {
      return { error: `${r.ref.path} did not load: ${(e as Error).message.split("\n")[0]}` };
    }
  }
  if (html === undefined) return { error: `${r.ref.path} did not load` };
  if (!r.ref.anchor) return { html, text: visibleText(html) };
  const section = elementById(html, r.ref.anchor);
  if (section === null) return { error: `#${r.ref.anchor} is not on ${r.ref.path}` };
  return { html: section, text: visibleText(section) };
}

export async function pricingGate(site: Site | null, dir: string | null, content: ContentMap | null, judges: Judge[], why = "no site to check"): Promise<Gate> {
  const id = "pricing";
  if (!site) return agate(id, "fail", `cannot run: ${why}`);
  if (!dir) return agate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  const pair = judgePairProblem(judges);
  if (pair) return agate(id, "fail", `cannot run: ${pair}`);
  const cm = readCostModel(dir);
  if (!cm.model) return agate(id, "fail", `cannot run: ${cm.error}`);
  const model = cm.model;
  const where = model.pricing_page ?? content?.refs.find((r) => r.key === "pricing")?.raw ?? "/pricing/";
  const page = await pageText(site, where);
  if (page.text === undefined) return agate(id, "fail", `cannot run: pricing content ${page.error}`);
  const text = page.text;
  const amounts = moneyAmounts(text);
  const { problems, acquisition } = costModelProblems(model);
  const shown = (n: number) => amounts.some((a) => Math.abs(a - n) < 0.0005);
  const tiers = model.tiers.map((t) => {
    const named = new RegExp(`(^|[^\\p{L}\\p{N}])${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(text);
    const priced =
      t.price === null ? /\b(contact|custom|talk to|get a quote|quote)\b/i.test(text) : t.price === 0 ? shown(0) || /\bfree\b/i.test(text) : shown(t.price);
    if (!named) problems.push(`tier "${t.name}" is not on the pricing content`);
    if (!priced) problems.push(`tier "${t.name}": price ${t.price === null ? "contact us" : t.price} is not on the pricing content`);
    const overages = t.overages.filter((o) => o.price !== null).map((o) => ({ ...o, on_page: shown(o.price!) }));
    for (const o of overages) if (!o.on_page) problems.push(`tier "${t.name}": overage ${o.price} per ${o.unit} is not on the pricing content`);
    return {
      name: t.name,
      price: t.price,
      cost_to_serve: t.cost_to_serve,
      margin: t.price === null ? null : cents(t.price - t.cost_to_serve),
      below_cost: t.price !== null && cents(t.cost_to_serve) > cents(t.price),
      on_page: named,
      price_on_page: priced,
      ...(overages.length ? { overages } : {}),
    };
  });
  // The self-hosting path: named on the pricing content, or linked from it.
  const sh = model.self_hosting;
  const linked = (p: string | undefined) => !!p && !!page.html && new RegExp(`href\\s*=\\s*["']?(?:https?://[^/"']+)?${p.split("#")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(page.html);
  const selfHostShown = /self[- ]?host/i.test(text) || linked(sh?.path) || linked(sh?.costs_page);
  if (model.self_host && !selfHostShown) problems.push("the cost model has a self-hosting path but the pricing content neither shows nor links to it");
  if (sh) {
    const guide = await pageText(site, sh.path);
    if (guide.text === undefined) problems.push(`self_hosting.path: ${guide.error}`);
    if (sh.costs_page) {
      const costs = await pageText(site, sh.costs_page);
      if (costs.text === undefined) problems.push(`self_hosting.costs_page: ${costs.error}`);
    }
  }
  const known = new Set<number>();
  for (const t of model.tiers) {
    if (t.price !== null) known.add(t.price);
    for (const o of t.overages) if (o.price !== null) known.add(o.price);
  }
  if (sh) known.add(sh.price);
  const unreconciled = [...new Set(amounts.filter((a) => ![...known].some((k) => Math.abs(k - a) < 0.0005)))];
  const verdict = await askBoth(
    judges,
    request(
      "pricing",
      "Does the pricing text contradict the cost model: a tier, price, usage limit, inclusion, discount or self-hosting promise that the cost model does not contain or that would be sold below its cost to serve? A free tier the cost model declares below_cost with a below_cost_reason is an accepted acquisition cost, not a contradiction. Amounts not in the cost model are listed in unreconciled_amounts; answer yes if any of them is a price the cost model cannot support.",
      { pricing_text: text.slice(0, 6000), cost_model: { ...model, sources: undefined }, unreconciled_amounts: unreconciled },
    ),
  );
  const judged: GateStatus = verdict.outcome === "yes" ? "fail" : verdict.outcome === "split" ? "warn" : "pass";
  const status = problems.length ? "fail" : judged;
  const metrics = { tiers: tiers.length, problems: problems.length, acquisition_tiers: acquisition.length, unreconciled_amounts: unreconciled.length, judges_contradiction: verdict.outcome };
  const details = { content: where, cost_model: model, tiers, acquisition, self_host_shown: selfHostShown, unreconciled_amounts: unreconciled, problems, votes: votesOf(verdict) };
  const free = acquisition.length ? `; ${acquisition.map((a) => `${a.name} below cost as acquisition (${a.cost} ${model.currency}/${model.period})`).join(", ")}` : "";
  const summary = problems.length
    ? `${plural(problems.length, "problem")}: ${problems.slice(0, 3).join("; ")}`
    : judged === "fail"
      ? "both judges: the pricing content contradicts the cost model"
      : judged === "warn"
        ? `tiers and prices match the cost model; the judges split on a contradiction${free}`
        : `${plural(tiers.length, "tier")} on ${where} match the cost model, no paid price below cost${free}; judges found no contradiction`;
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
