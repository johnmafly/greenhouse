import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { nextRound, repoFromRemote, run, submit, type Deps } from "../src/submit.ts";
import { parseSubmissionYaml, serializeSubmission, validateSubmission, type Submission } from "../src/submit-schema.ts";

describe("round numbering", () => {
  test("first round is 01", () => {
    assert.equal(nextRound("demo", [], []), 1);
  });
  test("one past the highest round on main", () => {
    assert.equal(nextRound("demo", ["portfolio/demo/rounds/01", "portfolio/demo/rounds/03", "portfolio/demo/rounds/README.md"], []), 4);
  });
  test("counts open submission branches, ignoring other slugs", () => {
    const branches = ["refs/heads/submission/demo-02", "refs/heads/submission/demo-x-09", "refs/heads/submission/other-07"];
    assert.equal(nextRound("demo", ["portfolio/demo/rounds/01"], branches), 3);
    assert.equal(nextRound("demo-x", [], branches), 10);
  });
  test("goes past 99", () => {
    assert.equal(nextRound("demo", ["portfolio/demo/rounds/99"], []), 100);
  });
});

describe("submission.yaml", () => {
  const sub: Submission = {
    schema_version: 1,
    slug: "demo",
    round: 2,
    repo: "acme/demo",
    sha: "a".repeat(40),
    deployment_url: "https://demo.pages.dev",
    claims_sha256: "b".repeat(64),
    changelog: 'Fixed "pricing".\nNew: docs: search',
  };
  test("round-trips and validates", () => {
    const text = serializeSubmission(sub);
    assert.deepEqual(parseSubmissionYaml(text), sub);
    assert.deepEqual(validateSubmission(parseSubmissionYaml(text)), { valid: true, errors: [] });
  });
  test("reads plain YAML scalars like the #4 fixtures", () => {
    const doc = parseSubmissionYaml("schema_version: 1\nslug: botrampart\nround: 1\nrepo: johnmafly/botrampart\nsha: " + "a".repeat(40) + "\ndeployment_url: https://botrampart.pages.dev\nclaims_sha256: " + "b".repeat(64) + "\nchangelog: First submission.\n");
    assert.equal(validateSubmission(doc).valid, true);
  });
  test("rejects invalid documents (#4 field rules)", () => {
    assert.match(validateSubmission({ ...sub, round: 0 }).errors.join(), /round/);
    assert.match(validateSubmission({ ...sub, sha: "abc" }).errors.join(), /sha/);
    assert.match(validateSubmission({ ...sub, extra: 1 }).errors.join(), /unknown property 'extra'/);
    const { changelog: _c, ...noChangelog } = sub;
    assert.match(validateSubmission(noChangelog).errors.join(), /changelog/);
    assert.throws(() => parseSubmissionYaml("slug:\n  nested: 1\n"));
    assert.throws(() => parseSubmissionYaml("changelog: |\n  block\n"));
  });
});

test("repoFromRemote", () => {
  assert.equal(repoFromRemote("https://github.com/johnmafly/greenhouse.git\n"), "johnmafly/greenhouse");
  assert.equal(repoFromRemote("git@github.com:acme/demo-site.git"), "acme/demo-site");
  assert.throws(() => repoFromRemote("/tmp/x"));
});

// ---- End to end against local git repos (no network, no gh) ----

function git(cwd: string, ...args: string[]): string {
  const r = run("git", args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gh-submit-"));
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"];
  // Control repo: a bare "origin" with main holding round 01 for demo.
  const bare = join(root, "control.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", bare, seed);
  await mkdir(join(seed, "portfolio/demo/rounds/01"), { recursive: true });
  await writeFile(join(seed, "portfolio/demo/rounds/01/submission.yaml"), "x: 1\n");
  git(seed, "add", ".");
  git(seed, ...id, "commit", "--quiet", "-m", "round 01");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/submission/demo-02"); // an open round 02
  // The caller's clone. Its "origin" must look like GitHub for owner/name, so rewrite it.
  const control = join(root, "control");
  git(root, "clone", "--quiet", bare, control);
  git(control, "config", "user.name", "t");
  git(control, "config", "user.email", "t@example.test");
  git(control, "config", "commit.gpgsign", "false");
  git(control, "remote", "set-url", "origin", "https://github.com/johnmafly/greenhouse.git");
  git(control, "remote", "set-url", "--push", "origin", bare);
  git(control, "config", "url." + bare + ".insteadOf", "https://github.com/johnmafly/greenhouse.git");
  // Project repo
  const project = join(root, "project");
  git(root, "init", "--quiet", "-b", "main", project);
  await writeFile(join(project, "claims.yaml"), "claims: []\n");
  git(project, "add", ".");
  git(project, ...id, "commit", "--quiet", "-m", "init");
  git(project, "remote", "add", "origin", "git@github.com:acme/demo.git");
  return { root, bare, control, project, sha: git(project, "rev-parse", "HEAD") };
}

function deps(check: "pass" | "fail" | "unavailable", prs: unknown[]): Deps {
  return {
    run,
    runCheck: () => ({ status: check, detail: `check ${check}` }),
    createPr: (a) => {
      prs.push(a);
      return "https://github.com/johnmafly/greenhouse/pull/999";
    },
    log: () => {},
  };
}

describe("submit", () => {
  test("dry run computes round 03 and changes nothing", async () => {
    const f = await fixture();
    const prs: unknown[] = [];
    const plan = await submit({ project: f.project, slug: "demo", url: "https://demo.pages.dev", changelog: "", control: f.control, dryRun: true }, deps("pass", prs));
    assert.equal(plan.round, 3);
    assert.equal(plan.branch, "submission/demo-03");
    assert.equal(plan.path, "portfolio/demo/rounds/03/submission.yaml");
    assert.equal(plan.title, "submission: demo round 03");
    assert.equal(plan.submission.sha, f.sha);
    assert.equal(plan.submission.repo, "acme/demo");
    assert.equal(plan.submission.claims_sha256, createHash("sha256").update("claims: []\n").digest("hex"));
    assert.equal(plan.would_refuse, false);
    assert.equal(prs.length, 0);
    assert.equal(git(f.bare, "branch", "--list", "submission/demo-03"), "");
  });

  test("refuses when check fails or is unavailable", async () => {
    const f = await fixture();
    for (const status of ["fail", "unavailable"] as const) {
      const prs: unknown[] = [];
      await assert.rejects(
        submit({ project: f.project, slug: "demo", url: "https://demo.pages.dev", changelog: "", control: f.control, dryRun: false }, deps(status, prs)),
        /refusing to submit/,
      );
      assert.equal(prs.length, 0);
    }
    assert.equal(git(f.bare, "branch", "--list", "submission/demo-03"), "");
  });

  test("pushes only submission.yaml on submission/<slug>-NN and opens the PR", async () => {
    const f = await fixture();
    const prs: { repo: string; branch: string; title: string; body: string }[] = [];
    const before = git(f.control, "status", "--porcelain");
    const plan = await submit({ project: f.project, slug: "demo", url: "https://demo.pages.dev", changelog: "First pass", control: f.control, dryRun: false }, deps("pass", prs as unknown[]));
    assert.equal(plan.pr_url, "https://github.com/johnmafly/greenhouse/pull/999");
    assert.equal(prs[0].repo, "johnmafly/greenhouse");
    assert.equal(prs[0].title, "submission: demo round 03");
    assert.equal(prs[0].branch, "submission/demo-03");
    const changed = git(f.bare, "diff", "--name-status", "main", "submission/demo-03");
    assert.equal(changed, "A\tportfolio/demo/rounds/03/submission.yaml");
    const yaml = git(f.bare, "show", "submission/demo-03:portfolio/demo/rounds/03/submission.yaml");
    assert.deepEqual(validateSubmission(parseSubmissionYaml(yaml)), { valid: true, errors: [] });
    assert.equal(parseSubmissionYaml(yaml).changelog, "First pass");
    assert.equal(git(f.control, "status", "--porcelain"), before, "caller's checkout untouched");
    assert.equal(git(f.control, "worktree", "list").split("\n").length, 1, "temporary worktree removed");

    // The next submission sees the new branch and takes round 04.
    const again = await submit({ project: f.project, slug: "demo", url: "https://demo.pages.dev", changelog: "", control: f.control, dryRun: true }, deps("pass", []));
    assert.equal(again.round, 4);
  });

  test("refuses a project without a committed claims.yaml", async () => {
    const f = await fixture();
    git(f.project, "rm", "--quiet", "claims.yaml");
    git(f.project, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "rm");
    await assert.rejects(submit({ project: f.project, slug: "demo", url: "https://demo.pages.dev", changelog: "", control: f.control, dryRun: true }, deps("pass", [])), /claims\.yaml/);
  });
});
