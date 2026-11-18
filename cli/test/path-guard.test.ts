import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guard, parseSubmissionTitle } from "../src/submit-guard.ts";
import { serializeSubmission } from "../src/submit-schema.ts";

const P = "portfolio/demo/rounds/03/submission.yaml";
const yaml = (over: Record<string, unknown> = {}) =>
  serializeSubmission({
    schema_version: 1,
    slug: "demo",
    round: 3,
    repo: "acme/demo",
    sha: "a".repeat(40),
    deployment_url: "https://demo.pages.dev",
    claims_sha256: "b".repeat(64),
    changelog: "",
    ...over,
  } as never);
const added = (filename: string) => ({ filename, status: "added" });

describe("path-guard", () => {
  test("title format", () => {
    assert.deepEqual(parseSubmissionTitle("submission: demo round 03"), { slug: "demo", round: 3 });
    assert.deepEqual(parseSubmissionTitle("submission: demo round 123"), { slug: "demo", round: 123 });
    assert.equal(parseSubmissionTitle("submission: demo round 3"), null);
    assert.equal(parseSubmissionTitle("submission: demo round 00"), null);
    assert.equal(parseSubmissionTitle("submission: Demo round 01"), null);
  });

  test("passes a submission that adds only its submission.yaml", () => {
    assert.deepEqual(guard("submission: demo round 03", [added(P)], yaml()), { submission: true, ok: true, errors: [], slug: "demo", round: 3 });
  });

  test("fails on a file outside the round folder", () => {
    const r = guard("submission: demo round 03", [added(P), { filename: "rubric/rubric-v1.yaml", status: "modified" }], yaml());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /rubric\/rubric-v1\.yaml: outside portfolio\/demo\/rounds\/03\//);
  });

  test("fails on another project's or another round's folder", () => {
    assert.equal(guard("submission: demo round 03", [added(P), added("portfolio/other/rounds/03/submission.yaml")], yaml()).ok, false);
    assert.equal(guard("submission: demo round 03", [added("portfolio/demo/rounds/02/submission.yaml")], yaml()).ok, false);
  });

  test("fails when more than submission.yaml is added (the judge writes the rest)", () => {
    const r = guard("submission: demo round 03", [added(P), added("portfolio/demo/rounds/03/score.json")], yaml());
    assert.match(r.errors.join(), /may only add portfolio\/demo\/rounds\/03\/submission\.yaml/);
  });

  test("fails when submission.yaml is modified or removed rather than added", () => {
    assert.match(guard("submission: demo round 03", [{ filename: P, status: "modified" }], yaml()).errors.join(), /must be added/);
    assert.equal(guard("submission: demo round 03", [{ filename: P, status: "removed" }], yaml()).ok, false);
  });

  test("fails on renames into the round folder", () => {
    const r = guard("submission: demo round 03", [{ filename: P, status: "renamed", previous_filename: "elsewhere.yaml" }], yaml());
    assert.match(r.errors.join(), /renames are not allowed/);
  });

  test("fails when the PR adds nothing", () => {
    assert.match(guard("submission: demo round 03", [], yaml()).errors.join(), /is not added/);
  });

  test("fails a malformed submission title", () => {
    const r = guard("submission: demo r3", [added(P)], yaml());
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /title must be/);
  });

  test("fails when submission.yaml does not match its title or schema", () => {
    assert.match(guard("submission: demo round 03", [added(P)], yaml({ round: 4 })).errors.join(), /round 4 does not match/);
    assert.match(guard("submission: demo round 03", [added(P)], yaml({ slug: "other" })).errors.join(), /slug 'other' does not match/);
    assert.match(guard("submission: demo round 03", [added(P)], yaml({ sha: "short" })).errors.join(), /\/sha/);
    assert.match(guard("submission: demo round 03", [added(P)], "nested:\n  x: 1\n").errors.join(), /line 1/);
    assert.match(guard("submission: demo round 03", [added(P)], null).errors.join(), /content not available/);
  });

  test("non-submission PRs pass unless they touch a submission.yaml", () => {
    assert.deepEqual(guard("feat: board tweaks", [{ filename: "board/build.ts", status: "modified" }]), { submission: false, ok: true, errors: [] });
    assert.deepEqual(guard("ruling: demo round 03", [added("portfolio/demo/rounds/03/score.json"), added("portfolio/demo/rounds/03/ruling.md")]).ok, true);
    const r = guard("chore: sneak", [added("portfolio/demo/rounds/04/submission.yaml")]);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /only a 'submission:' pull request/);
  });

  test("workflow runs the base branch's guard and never checks out PR code", () => {
    const wf = readFileSync(".github/workflows/path-guard.yml", "utf8");
    assert.match(wf, /pull_request_target:/);
    assert.match(wf, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.doesNotMatch(wf, /head\.sha|head\.ref|pull_request\.head/);
    assert.match(wf, /contents: read/);
    assert.doesNotMatch(wf, /: write/);
    assert.match(wf, /node cli\/src\/submit-guard\.ts/);
  });
});
