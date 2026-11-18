// Mechanical scoring of a judged round (plan v7, section 6).
// Pure: computeScore() depends only on its inputs, so the same inputs give byte-identical score.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertValid, parseDocument } from "./schemas.ts";
import type { Checks, Review, Rubric, Score, Submission } from "./schemas.ts";
import { capMax, loadRubric } from "./rubric.ts";

/**
 * Gate ids whose failure carries a named cap reason. Any other failed gate caps with
 * reason `failed_gate:<id>`. The checks module (greenhouse check) should use these ids.
 */
export const CAP_GATES: Record<string, { cap: "quality" | "integrity"; reason: string }> = {
  "claims": { cap: "quality", reason: "unsupported_claim" },
  "critical-assumptions": { cap: "quality", reason: "untested_critical_assumption" },
  "intake-drift": { cap: "quality", reason: "intake_drift" },
  "social-proof": { cap: "integrity", reason: "invented_social_proof" },
  "reviewer-instruction": { cap: "integrity", reason: "reviewer_instruction" },
  // Decision 0003: a canary hit caps the composite at 5.0 and is a suspected breach reported to
  // the owner (the integrity cap carries report_to_owner in the rubric).
  "canary": { cap: "integrity", reason: "canary_leak" },
  // Decision 0004: motion must respect prefers-reduced-motion.
  "reduced-motion": { cap: "quality", reason: "motion_ignores_reduced_motion" },
};

/**
 * Rubric v2 sameness cap: applies when a strict majority of the panel sets the review flag
 * template_structure (2 of 3, 3 of 4, 3 of 5).
 */
export function panelMajority(flagged: number, panel: number): boolean {
  return panel > 0 && flagged * 2 > panel;
}

export interface ReviewInput {
  /** File name under reviews/, e.g. "1.json". Keys inputs.reviews_sha256. */
  file: string;
  sha256: string;
  review: Review;
}

export interface ScoreInputs {
  rubric: Rubric;
  submission: Submission;
  checks: Checks;
  checksSha256: string;
  reviews: ReviewInput[];
  /** True until validation tests 1 to 5 pass. Default true. A provisional score never graduates. */
  provisional?: boolean;
  costUsd?: number | null;
  /** ISO 8601. Defaults to checks.finished_at so output stays deterministic. */
  decidedAt?: string;
}

export class ScoreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreInputError";
  }
}

/** Round to 3 decimals; scores and thresholds are compared on the rounded value. */
export function round3(x: number): number {
  return Math.round((x + Number.EPSILON) * 1000) / 1000;
}

/** Median; for an even count, the mean of the two middle values. */
export function median(values: number[]): number {
  if (values.length === 0) throw new ScoreInputError("median of no values");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function weightedComposite(rubric: Rubric, scores: Record<string, number>): number {
  let sum = 0;
  let wsum = 0;
  for (const d of rubric.dimensions) {
    sum += d.weight * scores[d.id];
    wsum += d.weight;
  }
  return sum / wsum;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function checkConsistency(inp: ScoreInputs): void {
  const { rubric, submission: sub, checks, reviews } = inp;
  const fail = (m: string) => {
    throw new ScoreInputError(m);
  };
  for (const k of ["slug", "round", "sha", "deployment_url"] as const) {
    if (sub[k] !== checks[k]) fail(`checks.json ${k} '${checks[k]}' does not match submission '${sub[k]}'`);
  }
  if (reviews.length === 0) fail("no reviews");
  if (reviews.length < rubric.panel.reviewers) {
    fail(`panel has ${reviews.length} reviewers; rubric v${rubric.version} requires at least ${rubric.panel.reviewers}`);
  }
  const families = new Set(reviews.map((r) => r.review.reviewer.family));
  if (families.size < rubric.panel.min_families) {
    fail(`panel spans ${families.size} model families; rubric v${rubric.version} requires at least ${rubric.panel.min_families}`);
  }
  const ids = new Set<string>();
  const dims = rubric.dimensions.map((d) => d.id);
  for (const { file, review } of reviews) {
    const who = `review ${file} (${review.reviewer.id})`;
    if (ids.has(review.reviewer.id)) fail(`duplicate reviewer id '${review.reviewer.id}'`);
    ids.add(review.reviewer.id);
    if (review.rubric_version !== rubric.version) fail(`${who} uses rubric v${review.rubric_version}, scoring with v${rubric.version}`);
    if (review.reviewer.brief_version !== reviews[0].review.reviewer.brief_version) fail(`${who} uses brief ${review.reviewer.brief_version}, others ${reviews[0].review.reviewer.brief_version}`);
    if (review.bundle_hash !== reviews[0].review.bundle_hash) fail(`${who} reviewed a different evidence bundle`);
    if (checks.bundle_hash !== undefined && review.bundle_hash !== checks.bundle_hash) fail(`${who} bundle_hash does not match checks.json bundle_hash`);
    for (const d of dims) if (!(d in review.scores)) fail(`${who} is missing dimension '${d}'`);
    for (const d of Object.keys(review.scores)) {
      if (!dims.includes(d)) fail(`${who} scores unknown dimension '${d}'`);
      const v = review.scores[d];
      if (v < rubric.scale.min || v > rubric.scale.max) fail(`${who} score ${d}=${v} is outside ${rubric.scale.min}..${rubric.scale.max}`);
    }
  }
}

/** Compute score.json. Throws ScoreInputError when inputs are inconsistent: a round is never half-scored. */
export function computeScore(inp: ScoreInputs): Score {
  checkConsistency(inp);
  const { rubric, submission: sub, checks } = inp;
  const reviews = [...inp.reviews].sort((a, b) => byString(a.review.reviewer.id, b.review.reviewer.id));
  const provisional = inp.provisional ?? true;

  const dimension_medians: Record<string, number> = {};
  for (const d of rubric.dimensions) dimension_medians[d.id] = round3(median(reviews.map((r) => r.review.scores[d.id])));

  const reviewer_composites: Record<string, number> = {};
  for (const r of reviews) reviewer_composites[r.review.reviewer.id] = round3(weightedComposite(rubric, r.review.scores));

  const composite_raw = round3(weightedComposite(rubric, dimension_medians));

  // Caps: one entry per distinct reason, ordered by max then reason.
  const caps = new Map<string, number>();
  const failed = checks.gates.filter((g) => g.status === "fail");
  for (const g of failed) {
    const named = CAP_GATES[g.id];
    caps.set(named ? named.reason : `failed_gate:${g.id}`, capMax(rubric, named ? named.cap : "quality"));
  }
  const integrity = capMax(rubric, "integrity");
  if (reviews.some((r) => r.review.flags.invented_social_proof)) caps.set("invented_social_proof", integrity);
  if (reviews.some((r) => r.review.flags.reviewer_instruction)) caps.set("reviewer_instruction", integrity);
  const sameFlags = reviews.filter((r) => r.review.flags.template_structure).length;
  if (panelMajority(sameFlags, reviews.length)) caps.set("template_sameness", capMax(rubric, "sameness"));
  const caps_applied = [...caps]
    .map(([reason, max]) => ({ reason, max }))
    .sort((a, b) => a.max - b.max || byString(a.reason, b.reason));
  const composite = round3(Math.min(composite_raw, ...caps_applied.map((c) => c.max)));

  const gates_green = checks.all_green && failed.length === 0;
  const g = rubric.graduation;
  const graduation_eligible =
    !provisional &&
    gates_green &&
    composite >= g.composite_min &&
    Object.values(dimension_medians).every((m) => m >= g.dimension_median_min) &&
    (g.focus_dimensions ?? []).every((d) => dimension_medians[d] >= (g.focus_median_min ?? g.dimension_median_min)) &&
    Object.values(reviewer_composites).every((c) => c >= g.reviewer_composite_min);

  const reviews_sha256: Record<string, string> = {};
  for (const r of [...inp.reviews].sort((a, b) => byString(a.file, b.file))) reviews_sha256[r.file] = r.sha256;

  const score: Score = {
    schema_version: 1,
    slug: sub.slug,
    round: sub.round,
    sha: sub.sha,
    rubric_version: rubric.version,
    brief_version: reviews[0].review.reviewer.brief_version,
    provisional,
    panel: reviews.map((r) => ({ id: r.review.reviewer.id, model: r.review.reviewer.model, family: r.review.reviewer.family })),
    dimension_medians,
    reviewer_composites,
    composite_raw,
    caps_applied,
    composite,
    gates_green,
    graduation_eligible,
    inputs: {
      checks_sha256: inp.checksSha256,
      reviews_sha256,
      bundle_hash: checks.bundle_hash ?? reviews[0].review.bundle_hash,
    },
    cost_usd: inp.costUsd ?? null,
    decided_at: inp.decidedAt ?? checks.finished_at,
  };
  return assertValid<Score>("score", score, "computed score.json");
}

export function serializeScore(score: Score): string {
  return JSON.stringify(score, null, 2) + "\n";
}

export interface ScoreRoundOptions {
  /** Rubric file. Default: rubric/rubric-v<rubric_version of the reviews>.yaml. */
  rubricPath?: string;
  provisional?: boolean;
  costUsd?: number | null;
  decidedAt?: string;
}

function readValidated<T>(path: string, schema: "submission" | "checks" | "review"): { doc: T; bytes: Buffer } {
  if (!existsSync(path)) throw new ScoreInputError(`missing ${path}`);
  const bytes = readFileSync(path);
  return { doc: assertValid<T>(schema, parseDocument(bytes.toString("utf8"), path), path), bytes };
}

/** Load portfolio/<slug>/rounds/NN/{submission.yaml,checks.json,reviews/*.json} and score it. */
export function scoreRoundDir(roundDir: string, opts: ScoreRoundOptions = {}): { score: Score; json: string } {
  const subPath = ["submission.yaml", "submission.yml"].map((f) => join(roundDir, f)).find(existsSync) ?? join(roundDir, "submission.yaml");
  const submission = readValidated<Submission>(subPath, "submission").doc;
  const checksRead = readValidated<Checks>(join(roundDir, "checks.json"), "checks");
  const reviewsDir = join(roundDir, "reviews");
  if (!existsSync(reviewsDir)) throw new ScoreInputError(`missing ${reviewsDir}`);
  const files = readdirSync(reviewsDir).filter((f) => f.endsWith(".json")).sort(byString);
  const reviews: ReviewInput[] = files.map((file) => {
    const { doc, bytes } = readValidated<Review>(join(reviewsDir, file), "review");
    return { file, sha256: sha256(bytes), review: doc };
  });
  if (reviews.length === 0) throw new ScoreInputError(`no reviews in ${reviewsDir}`);
  const rubric = loadRubric(opts.rubricPath ?? reviews[0].review.rubric_version);
  const score = computeScore({
    rubric,
    submission,
    checks: checksRead.doc,
    checksSha256: sha256(checksRead.bytes),
    reviews,
    provisional: opts.provisional,
    costUsd: opts.costUsd,
    decidedAt: opts.decidedAt,
  });
  return { score, json: serializeScore(score) };
}
