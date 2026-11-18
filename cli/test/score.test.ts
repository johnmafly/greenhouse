import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CAP_GATES, ScoreInputError, computeScore, median, scoreRoundDir, serializeScore } from "../src/lib/score.ts";
import type { ReviewInput, ScoreInputs } from "../src/lib/score.ts";
import { loadRubric } from "../src/lib/rubric.ts";
import { readDocument } from "../src/lib/schemas.ts";
import type { Checks, Review, Submission } from "../src/lib/schemas.ts";

const ROUND = join(import.meta.dirname, "fixtures", "round-01");
const rubric = loadRubric(1);
const DIMS = rubric.dimensions.map((d) => d.id);
const clone = <T>(x: T): T => structuredClone(x);

function base(): ScoreInputs {
  const reviews: ReviewInput[] = ["1.json", "2.json", "3.json"].map((file) => ({
    file,
    sha256: "0".repeat(64),
    review: readDocument(join(ROUND, "reviews", file)) as Review,
  }));
  return {
    rubric,
    submission: readDocument(join(ROUND, "submission.yaml")) as Submission,
    checks: readDocument(join(ROUND, "checks.json")) as Checks,
    checksSha256: "1".repeat(64),
    reviews,
  };
}

/** A review with every dimension set to `v` (overrides per dimension). */
function review(id: string, family: string, v: number, over: Record<string, number> = {}): Review {
  const r = clone(base().reviews[0].review);
  r.reviewer = { ...r.reviewer, id, model: `${family}-model`, family };
  r.scores = Object.fromEntries(DIMS.map((d) => [d, over[d] ?? v]));
  return r;
}
function withReviews(inp: ScoreInputs, reviews: Review[]): ScoreInputs {
  return { ...inp, reviews: reviews.map((review, i) => ({ file: `${i + 1}.json`, sha256: "0".repeat(64), review })) };
}
function failGate(inp: ScoreInputs, id: string): ScoreInputs {
  const checks = clone(inp.checks);
  checks.gates.push({ id, class: "assisted", status: "fail", summary: `${id} failed` });
  checks.all_green = false;
  return { ...inp, checks };
}

// ---- median ----

test("median: odd, even (mean of middle two), ties, unsorted input", () => {
  assert.equal(median([8, 9, 10]), 9);
  assert.equal(median([10, 7, 9, 8]), 8.5);
  assert.equal(median([9, 9, 8, 9]), 9);
  assert.equal(median([7, 7, 7]), 7);
  assert.equal(median([6]), 6);
  assert.throws(() => median([]), ScoreInputError);
});

// ---- golden round ----

test("golden round: matches committed score.json byte for byte", () => {
  const { json } = scoreRoundDir(ROUND);
  assert.equal(json, readFileSync(join(ROUND, "score.json"), "utf8"));
});

test("golden round: medians, reviewer composites, composite at the 9.0 boundary", () => {
  const s = scoreRoundDir(ROUND).score;
  assert.deepEqual(Object.keys(s.dimension_medians), DIMS);
  assert.ok(Object.values(s.dimension_medians).every((m) => m === 9));
  assert.deepEqual(s.reviewer_composites, { "r-gemini": 9.225, "r-grok": 9, "r-openai": 8.95 });
  assert.equal(s.composite_raw, 9);
  assert.equal(s.composite, 9);
  assert.deepEqual(s.caps_applied, []);
  assert.equal(s.gates_green, true); // a 'warn' gate is still green
});

test("provisional by default: never graduation eligible", () => {
  const s = scoreRoundDir(ROUND).score;
  assert.equal(s.provisional, true);
  assert.equal(s.graduation_eligible, false);
});

test("validated: meets every graduation condition, composite exactly 9.0 is eligible", () => {
  const s = scoreRoundDir(ROUND, { provisional: false }).score;
  assert.equal(s.provisional, false);
  assert.equal(s.graduation_eligible, true);
});

test("input hashes are sha256 of the file bytes, keyed by review file name", () => {
  const s = scoreRoundDir(ROUND).score;
  const h = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  assert.equal(s.inputs.checks_sha256, h(join(ROUND, "checks.json")));
  assert.deepEqual(Object.keys(s.inputs.reviews_sha256), ["1.json", "2.json", "3.json"]);
  for (const f of ["1.json", "2.json", "3.json"]) assert.equal(s.inputs.reviews_sha256[f], h(join(ROUND, "reviews", f)));
  assert.equal(s.inputs.bundle_hash, (readDocument(join(ROUND, "checks.json")) as Checks).bundle_hash);
});

test("deterministic: review order does not change the output", () => {
  const inp = base();
  const a = serializeScore(computeScore(inp));
  const b = serializeScore(computeScore({ ...inp, reviews: [...inp.reviews].reverse() }));
  assert.equal(a, b);
});

// ---- caps ----

test("cap 7.0: failed deterministic gate", () => {
  const s = computeScore(failGate(base(), "broken-links"));
  assert.deepEqual(s.caps_applied, [{ reason: "failed_gate:broken-links", max: 7 }]);
  assert.equal(s.composite_raw, 9);
  assert.equal(s.composite, 7);
  assert.equal(s.gates_green, false);
  assert.equal(computeScore({ ...failGate(base(), "broken-links"), provisional: false }).graduation_eligible, false);
});

test("cap 7.0: unsupported claim, untested critical assumption, intake drift", () => {
  for (const [id, reason] of [["claims", "unsupported_claim"], ["critical-assumptions", "untested_critical_assumption"], ["intake-drift", "intake_drift"]]) {
    const inp = base();
    inp.checks = clone(inp.checks);
    inp.checks.gates = inp.checks.gates.filter((g) => g.id !== id);
    const s = computeScore(failGate(inp, id));
    assert.deepEqual(s.caps_applied, [{ reason, max: 7 }], id);
    assert.equal(s.composite, 7);
  }
  assert.equal(CAP_GATES["claims"].reason, "unsupported_claim");
});

test("cap 5.0: invented social proof or reviewer instruction flagged by any one reviewer", () => {
  for (const flag of ["invented_social_proof", "reviewer_instruction"] as const) {
    const inp = clone(base());
    inp.reviews[1].review.flags[flag] = true;
    const s = computeScore(inp);
    assert.deepEqual(s.caps_applied, [{ reason: flag, max: 5 }], flag);
    assert.equal(s.composite, 5);
    assert.equal(s.gates_green, true);
  }
});

test("cap 5.0 from an integrity gate, deduplicated with the reviewer flag", () => {
  const inp = failGate(base(), "social-proof");
  inp.reviews = clone(inp.reviews);
  inp.reviews[0].review.flags.invented_social_proof = true;
  assert.deepEqual(computeScore(inp).caps_applied, [{ reason: "invented_social_proof", max: 5 }]);
});

test("cap 5.0: a failed canary gate is an integrity cap (canary_leak, decision 0003)", () => {
  const s = computeScore(failGate(base(), "canary"));
  assert.deepEqual(s.caps_applied, [{ reason: "canary_leak", max: 5 }]);
  assert.equal(s.composite_raw, 9);
  assert.equal(s.composite, 5);
  assert.equal(s.gates_green, false);
  assert.deepEqual(CAP_GATES["canary"], { cap: "integrity", reason: "canary_leak" });
});

test("several caps: all listed (lowest first), composite takes the lowest", () => {
  const inp = failGate(failGate(base(), "lighthouse-perf"), "claims");
  inp.reviews = clone(inp.reviews);
  inp.reviews[2].review.flags.reviewer_instruction = true;
  const s = computeScore(inp);
  assert.deepEqual(s.caps_applied, [
    { reason: "reviewer_instruction", max: 5 },
    { reason: "failed_gate:lighthouse-perf", max: 7 },
    { reason: "unsupported_claim", max: 7 },
  ]);
  assert.equal(s.composite, 5);
});

test("a cap above the raw composite is listed but does not raise it", () => {
  const inp = withReviews(failGate(base(), "build"), [review("a", "openai", 4), review("b", "google", 4.5), review("c", "xai", 4)]);
  const s = computeScore(inp);
  assert.equal(s.composite_raw, 4);
  assert.equal(s.composite, 4);
  assert.deepEqual(s.caps_applied, [{ reason: "failed_gate:build", max: 7 }]);
});

// ---- panel sizes and ties ----

test("even reviewer count: median is the mean of the two middle scores", () => {
  const inp = withReviews(base(), [
    review("a", "openai", 9, { conviction: 7 }),
    review("b", "google", 9, { conviction: 8 }),
    review("c", "xai", 9, { conviction: 9 }),
    review("d", "google", 9, { conviction: 10 }),
  ]);
  const s = computeScore(inp);
  assert.equal(s.dimension_medians.conviction, 8.5);
  assert.equal(s.dimension_medians.docs_buildability, 9);
  assert.equal(s.panel.length, 4);
  assert.equal(s.composite_raw, 8.9); // 9 - 0.2 * 0.5
});

test("ties: identical scores and a tie at the median", () => {
  const inp = withReviews(base(), [review("a", "openai", 8), review("b", "google", 8), review("c", "xai", 8)]);
  const s = computeScore(inp);
  assert.ok(Object.values(s.dimension_medians).every((m) => m === 8));
  assert.deepEqual(s.reviewer_composites, { a: 8, b: 8, c: 8 });
  const tie = computeScore(withReviews(base(), [review("a", "openai", 9), review("b", "google", 9), review("c", "xai", 6)]));
  assert.equal(tie.dimension_medians.conviction, 9);
  assert.equal(tie.reviewer_composites.c, 6);
});

// ---- graduation thresholds ----

test("graduation: one dimension median under 8.0 blocks it even with composite >= 9", () => {
  const inp = withReviews(base(), [
    review("a", "openai", 10, { signup_value: 7.5 }),
    review("b", "google", 10, { signup_value: 7.5 }),
    review("c", "xai", 10, { signup_value: 7.5 }),
  ]);
  const s = computeScore({ ...inp, provisional: false });
  assert.ok(s.composite >= 9);
  assert.equal(s.graduation_eligible, false);
});

test("graduation: one reviewer composite under 8.5 blocks it", () => {
  const inp = withReviews(base(), [review("a", "openai", 9.5), review("b", "google", 9.5), review("c", "xai", 8.4)]);
  const s = computeScore({ ...inp, provisional: false });
  assert.equal(s.composite, 9.5);
  assert.equal(s.reviewer_composites.c, 8.4);
  assert.equal(s.graduation_eligible, false);
});

test("graduation: composite just under 9.0 is not eligible", () => {
  const inp = withReviews(base(), [review("a", "openai", 9, { signup_value: 8.9 }), review("b", "google", 9, { signup_value: 8.9 }), review("c", "xai", 9, { signup_value: 8.9 })]);
  const s = computeScore({ ...inp, provisional: false });
  assert.equal(s.composite, 8.995);
  assert.equal(s.graduation_eligible, false);
});

// ---- inputs that must fail loudly ----

test("missing dimension in a review fails, naming the reviewer and dimension", () => {
  const inp = clone(base());
  delete inp.reviews[1].review.scores.distinctness;
  assert.throws(() => computeScore(inp), (e: Error) => e instanceof ScoreInputError && /2\.json \(r-gemini\) is missing dimension 'distinctness'/.test(e.message));
});

test("unknown dimension in a review fails", () => {
  const inp = clone(base());
  inp.reviews[0].review.scores.vibes = 9;
  assert.throws(() => computeScore(inp), /scores unknown dimension 'vibes'/);
});

test("panel too small or single-family fails", () => {
  assert.throws(() => computeScore(withReviews(base(), [review("a", "openai", 9), review("b", "google", 9)])), /requires at least 3/);
  assert.throws(() => computeScore(withReviews(base(), [review("a", "openai", 9), review("b", "openai", 9), review("c", "openai", 9)])), /1 model families/);
  assert.throws(() => computeScore(withReviews(base(), [review("a", "openai", 9), review("a", "google", 9), review("c", "xai", 9)])), /duplicate reviewer id 'a'/);
});

test("mismatched submission, checks, rubric, brief or bundle fails", () => {
  const sha = clone(base());
  sha.checks.sha = "f".repeat(40);
  assert.throws(() => computeScore(sha), /checks\.json sha/);
  const rv = clone(base());
  rv.reviews[0].review.rubric_version = 2;
  assert.throws(() => computeScore(rv), /uses rubric v2/);
  const brief = clone(base());
  brief.reviews[2].review.reviewer.brief_version = "brief-v2";
  assert.throws(() => computeScore(brief), /uses brief brief-v2/);
  const bundle = clone(base());
  bundle.reviews[1].review.bundle_hash = "e".repeat(64);
  assert.throws(() => computeScore(bundle), /different evidence bundle/);
});

test("without checks.bundle_hash, inputs.bundle_hash comes from the reviews", () => {
  const inp = clone(base());
  delete inp.checks.bundle_hash;
  assert.equal(computeScore(inp).inputs.bundle_hash, inp.reviews[0].review.bundle_hash);
});

// ---- CLI ----

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["cli/src/main.ts", "score", ...args], { encoding: "utf8" });
}

test("greenhouse score: writes byte-identical output on repeated runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-score-"));
  cpSync(ROUND, dir, { recursive: true });
  const r1 = cli("--round-dir", dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /composite 9 \(provisional\), graduation_eligible false/);
  const first = readFileSync(join(dir, "score.json"));
  assert.equal(cli("--round-dir", dir).status, 0);
  assert.ok(first.equals(readFileSync(join(dir, "score.json"))));
  assert.ok(first.equals(readFileSync(join(ROUND, "score.json"))));
});

test("greenhouse score --check: 0 when unchanged, 1 when score.json differs", () => {
  assert.equal(cli("--round-dir", ROUND, "--check").status, 0);
  const dir = mkdtempSync(join(tmpdir(), "gh-score-"));
  cpSync(ROUND, dir, { recursive: true });
  writeFileSync(join(dir, "score.json"), "{}\n");
  assert.equal(cli("--round-dir", dir, "--check").status, 1);
});

test("greenhouse score: --validated, --cost-usd, --decided-at, --out -", () => {
  const r = cli("--round-dir", ROUND, "--validated", "--cost-usd", "3.5", "--decided-at", "2026-11-19T08:00:00Z", "--out", "-");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.provisional, false);
  assert.equal(s.graduation_eligible, true);
  assert.equal(s.cost_usd, 3.5);
  assert.equal(s.decided_at, "2026-11-19T08:00:00Z");
});

test("greenhouse score: bad input exits 1, usage errors exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-score-"));
  cpSync(ROUND, dir, { recursive: true });
  const rv = JSON.parse(readFileSync(join(dir, "reviews", "3.json"), "utf8"));
  delete rv.scores.pricing_oss;
  writeFileSync(join(dir, "reviews", "3.json"), JSON.stringify(rv));
  const r = cli("--round-dir", dir, "--out", "-");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing dimension 'pricing_oss'/);
  assert.equal(r.stdout, "");
  assert.equal(cli("--round-dir", join(dir, "nope")).status, 1);
  assert.equal(cli().status, 2);
  assert.equal(cli("--round-dir", ROUND, "--cost-usd", "lots").status, 2);
  assert.equal(cli("--round-dir", ROUND, "--decided-at", "tomorrow", "--out", "-").status, 1);
});
