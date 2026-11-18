import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SCHEMA_NAMES, inferSchema, loadSchema, readDocument, validate, validateFile } from "../../cli/src/lib/schemas.ts";
import type { Intake } from "../../cli/src/lib/schemas.ts";
import { loadRubric } from "../../cli/src/lib/rubric.ts";

const FIX = join(import.meta.dirname, "fixtures");
const DOC_SCHEMAS = ["intake", "claims", "submission", "checks", "review", "score"] as const;

// Expected error (substring) for every invalid fixture, so each fails for the planted reason.
const EXPECTED: Record<string, string> = {
  "intake/bad-status.yaml": "/status: must be one of",
  "intake/missing-chief.yaml": "must have required property 'chief'",
  "intake/approved-not-date.yaml": "/approved_by_owner",
  "intake/unknown-field.yaml": "unknown property 'tagline'",
  "claims/no-quote.yaml": "must have required property 'quote'",
  "claims/duplicate-id.yaml": "duplicate claim id 'c1'",
  "claims/bad-source-url.yaml": "/claims/0/source_url",
  "submission/short-sha.yaml": "/sha: must match pattern",
  "submission/round-zero.yaml": "/round: must be >= 1",
  "submission/missing-changelog.yaml": "must have required property 'changelog'",
  "checks/all-green-with-failed-gate.json": "/all_green: must be false",
  "checks/bad-gate-class.json": "/gates/0/class: must be one of",
  "checks/bad-timestamp.json": "/finished_at: must match format \"date-time\"",
  "checks/duplicate-gate.json": "duplicate gate id 'build'",
  "review/score-over-10.json": "/scores/conviction: must be <= 10",
  "review/bad-severity.json": "/findings/0/severity: must be one of",
  "review/missing-flag.json": "must have required property 'reviewer_instruction'",
  "review/finding-unscored-dimension.json": "'vibes' is not a scored dimension",
  "score/cap-without-max.json": "must have required property 'max'",
  "score/negative-cost.json": "/cost_usd",
  "score/missing-checks-hash.json": "must have required property 'checks_sha256'",
};

test("every schema is draft 2020-12 with an $id", () => {
  for (const name of SCHEMA_NAMES) {
    const s = loadSchema(name);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.match(String(s.$id), new RegExp(`/schemas/${name}\\.schema\\.json$`));
  }
});

for (const name of DOC_SCHEMAS) {
  const valid = readdirSync(join(FIX, name, "valid"));
  const invalid = readdirSync(join(FIX, name, "invalid"));
  test(`${name}: has valid and invalid fixtures`, () => {
    assert.ok(valid.length > 0 && invalid.length > 0);
  });
  for (const f of valid) {
    test(`${name}: valid/${f} passes`, () => {
      const r = validate(name, readDocument(join(FIX, name, "valid", f)));
      assert.deepEqual(r.errors, []);
      assert.equal(r.valid, true);
    });
  }
  for (const f of invalid) {
    test(`${name}: invalid/${f} fails for the planted reason`, () => {
      const r = validate(name, readDocument(join(FIX, name, "invalid", f)));
      assert.equal(r.valid, false);
      const want = EXPECTED[`${name}/${f}`];
      assert.ok(want, `no expected error listed for ${name}/${f}`);
      assert.ok(r.errors.some((e) => e.includes(want)), `expected '${want}' in:\n${r.errors.join("\n")}`);
    });
  }
}

test("intake: budget.rounds defaults to 6", () => {
  const doc = readDocument(join(FIX, "intake", "valid", "intake.yaml")) as Intake;
  assert.equal(doc.budget.rounds, undefined);
  assert.equal(validate("intake", doc).valid, true);
  assert.equal(doc.budget.rounds, 6);
  const draft = readDocument(join(FIX, "intake", "valid", "draft-intake.yaml")) as Intake;
  validate("intake", draft);
  assert.equal(draft.budget.rounds, 8);
});

test("YAML dates stay strings (format date applies)", () => {
  const doc = readDocument(join(FIX, "intake", "valid", "intake.yaml")) as Intake;
  assert.equal(doc.approved_by_owner, "2026-11-18");
});

test("rubric v1 loads: 8 dimensions, weights sum to 1, caps 7.0 and 5.0", () => {
  const r = loadRubric(1);
  assert.equal(r.version, 1);
  assert.equal(r.dimensions.length, 8);
  assert.ok(Math.abs(r.dimensions.reduce((s, d) => s + d.weight, 0) - 1) < 1e-9);
  assert.deepEqual(r.caps.map((c) => [c.id, c.max]), [["quality", 7], ["integrity", 5]]);
});

test("rubric: weights that do not sum to 1 are rejected", () => {
  const r = readDocument("rubric/rubric-v1.yaml") as { dimensions: { weight: number }[] };
  r.dimensions[0].weight = 0.3;
  const v = validate("rubric", r);
  assert.equal(v.valid, false);
  assert.match(v.errors.join("\n"), /weights sum to 1\.1/);
});

test("inferSchema maps Greenhouse file names", () => {
  assert.equal(inferSchema("portfolio/x/intake.yaml"), "intake");
  assert.equal(inferSchema("claims.yaml"), "claims");
  assert.equal(inferSchema("portfolio/x/rounds/01/submission.yaml"), "submission");
  assert.equal(inferSchema("portfolio/x/rounds/01/checks.json"), "checks");
  assert.equal(inferSchema("portfolio/x/rounds/01/reviews/2.json"), "review");
  assert.equal(inferSchema("portfolio/x/rounds/01/score.json"), "score");
  assert.equal(inferSchema("rubric/rubric-v1.yaml"), "rubric");
  assert.equal(inferSchema("schemas/score.schema.json"), undefined);
  assert.equal(inferSchema("README.md"), undefined);
});

test("validateFile with an explicit schema", () => {
  const r = validateFile(join(FIX, "review", "valid", "review.json"), "review");
  assert.equal(r.valid, true);
  assert.equal(r.schema, "review");
});

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["cli/src/main.ts", "validate", ...args], { encoding: "utf8" });
}

test("greenhouse validate: valid file exits 0", () => {
  const r = cli(join(FIX, "checks", "valid", "checks.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok .*checks\.json \(checks\)/);
});

test("greenhouse validate: invalid file exits 1 and lists errors", () => {
  const r = cli("--schema", "intake", join(FIX, "intake", "invalid", "bad-status.yaml"));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /invalid .*\(intake\):\n {2}\/status: must be one of/);
});

test("greenhouse validate: unknown file kind or schema exits 2", () => {
  assert.equal(cli("README.md").status, 2);
  assert.equal(cli("--schema", "nope", "README.md").status, 2);
  assert.equal(cli().status, 2);
});

test("greenhouse validate: unparseable file exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-validate-"));
  const bad = join(dir, "checks.json");
  writeFileSync(bad, "{not json");
  const r = cli(bad);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /checks\.json/);
});

test("every committed portfolio file with a known schema validates", () => {
  const files = (readdirSync("portfolio", { recursive: true }) as string[])
    .map((f) => join("portfolio", f))
    .filter((f) => /\.(ya?ml|json)$/.test(f) && inferSchema(f));
  for (const f of files) {
    const r = validateFile(f);
    assert.deepEqual(r.errors, [], f);
  }
});
