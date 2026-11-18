// greenhouse check: one passing and one failing fixture per deterministic gate that needs no browser,
// plus the local server, perf lock, Lighthouse thresholds and CLI. Browser gates: check-browser.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { validate } from "../src/lib/schemas.ts";
import { CAP_GATES } from "../src/lib/score.ts";
import { cleanBuild, buildEnv, scanCorpus } from "../src/check/build.ts";
import {
  canaryGate,
  deployedShaGate,
  linksGate,
  noindexGate,
  packageFilesGate,
  pageStructureGate,
  placeholderGate,
  routesGate,
  secretsGate,
  specSamplesGate,
} from "../src/check/gates.ts";
import { codeSamples, h1Count, htmlLang, references, title, visibleText } from "../src/check/html.ts";
import { classifyScore, lighthouseGate, medianOf } from "../src/check/lighthouse.ts";
import type { LhRun } from "../src/check/lighthouse.ts";
import { LockTimeoutError, acquireLock } from "../src/check/lock.ts";
import { headersFor, parseHeaders, serveStatic } from "../src/check/serve.ts";
import { runCheck } from "../src/check/run.ts";
import { FAKE_SHA, TEMPLATE, builtSite, edit, serveSite, templateRepo, tmp } from "./check-helpers.ts";

const page = (dir: string, route: string) => join(dir, route, "index.html");

// --- html extraction --------------------------------------------------------------------------

test("html: title, lang, h1 count, references, code samples, visible text", () => {
  const html = `<!doctype html><html lang="en"><head><title> A &amp; B </title><script src="/a.js"></script>
  <script>var s = "<h1>not a heading</h1> TODO";</script></head><body><!-- <h1>comment</h1> -->
  <h1 class="x">One</h1><a href='/docs/'>d</a><img src=/i.png alt="">
  <pre><code data-op="createProject">x</code></pre><p><code data-op="loose">y</code></p></body></html>`;
  assert.equal(title(html), "A & B");
  assert.equal(htmlLang(html), "en");
  assert.equal(h1Count(html), 1);
  assert.deepEqual(references(html).map((r) => `${r.tag}:${r.url}`).sort(), ["a:/docs/", "img:/i.png", "script:/a.js"]);
  assert.deepEqual(codeSamples(html), [{ op: "createProject", inPre: true }, { op: "loose", inPre: false }]);
  assert.doesNotMatch(visibleText(html), /TODO|not a heading/);
});

// --- local server -----------------------------------------------------------------------------

test("serve: _headers rules, directory index, /path -> /path/ redirect, 404.html", async () => {
  const rules = parseHeaders("/*\n  X-Robots-Tag: noindex\n/docs/:page/\n  X-A: 1\n! X-B\n");
  assert.deepEqual(headersFor(rules, "/docs/intro/"), { "x-robots-tag": "noindex", "x-a": "1" });
  assert.deepEqual(headersFor(rules, "/pricing/"), { "x-robots-tag": "noindex" });
  const dir = builtSite();
  const s = await serveStatic(dir);
  try {
    const home = await fetch(s.url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("x-robots-tag") ?? "", /noindex/);
    const redirect = await fetch(new URL("docs", s.url), { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/docs/");
    const missing = await fetch(new URL("nope/", s.url));
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Page not found/);
    assert.equal((await fetch(new URL("_headers", s.url))).status, 404);
    assert.equal((await fetch(new URL("..%2f..%2fetc/passwd", s.url))).status, 404);
  } finally {
    await s.close();
  }
});

// --- build ------------------------------------------------------------------------------------

test("build: passes on the template from a clean checkout and writes greenhouse.json with the sha", async () => {
  const { dir, sha } = templateRepo();
  writeFileSync(join(dir, "uncommitted.txt"), "not in the commit");
  const work = tmp();
  const r = await cleanBuild(dir, sha, work);
  assert.equal(r.gate.status, "pass", r.gate.summary);
  assert.ok(r.outputDir);
  const info = JSON.parse(readFileSync(join(r.outputDir as string, ".well-known", "greenhouse.json"), "utf8"));
  assert.equal(info.sha, sha);
  assert.equal(info.slug, "example-seed");
  assert.ok(!existsSync(join(r.checkoutDir as string, "uncommitted.txt")), "uncommitted files are not in the clean checkout");
  rmSync(work, { recursive: true, force: true });
});

test("build: fails when the build command fails, and when greenhouse.yaml is missing", async () => {
  const broken = templateRepo((d) => edit(join(d, "greenhouse.yaml"), (s) => s.replace("npm run build", "echo boom >&2; exit 3")));
  const r1 = await cleanBuild(broken.dir, broken.sha, tmp());
  assert.equal(r1.gate.status, "fail");
  assert.match(r1.gate.summary, /exit 3/);
  assert.match(JSON.stringify(r1.gate.details), /boom/);
  const noManifest = templateRepo((d) => unlinkSync(join(d, "greenhouse.yaml")));
  const r2 = await cleanBuild(noManifest.dir, noManifest.sha, tmp());
  assert.equal(r2.gate.status, "fail");
  assert.match(r2.gate.summary, /greenhouse.yaml is missing/);
  const r3 = await cleanBuild(broken.dir, FAKE_SHA, tmp());
  assert.equal(r3.gate.status, "fail");
  assert.match(r3.gate.summary, /cannot be checked out/);
});

test("build: the project's build sees no caller tokens, only the Pages variables", () => {
  process.env.GH_CHECK_TEST_TOKEN = "x";
  const env = buildEnv(FAKE_SHA);
  delete process.env.GH_CHECK_TEST_TOKEN;
  assert.equal(env.GH_CHECK_TEST_TOKEN, undefined);
  assert.equal(env.CF_PAGES_COMMIT_SHA, FAKE_SHA);
  assert.equal(env.GITHUB_SHA, undefined);
});

// --- package files ----------------------------------------------------------------------------

test("package-files: passes on the template, fails on invalid claims.yaml, a missing STATE.md and spec", () => {
  assert.equal(packageFilesGate(TEMPLATE).status, "pass");
  const { dir } = templateRepo((d) => {
    writeFileSync(join(d, "claims.yaml"), "claims:\n  - id: 1\n");
    unlinkSync(join(d, "STATE.md"));
    unlinkSync(join(d, "spec", "openapi.yaml"));
    edit(join(d, "greenhouse.yaml"), (s) => s.replace("production_branch: main", "production_branch: dev"));
  });
  const g = packageFilesGate(dir);
  assert.equal(g.status, "fail");
  const problems = (g.details as { problems: string[] }).problems.join("\n");
  assert.match(problems, /claims\.yaml/);
  assert.match(problems, /STATE\.md/);
  assert.match(problems, /spec\/openapi\.yaml/);
  assert.match(problems, /production_branch/);
  assert.equal(packageFilesGate(null).status, "fail");
});

// --- deployed sha -----------------------------------------------------------------------------

test("deployed-sha: passes when the deployment reports the sha and slug, fails otherwise", async () => {
  const s = await serveSite();
  try {
    assert.equal((await deployedShaGate(s.server.url, FAKE_SHA, "example-seed")).status, "pass");
    const wrong = await deployedShaGate(s.server.url, "f".repeat(40), "example-seed");
    assert.equal(wrong.status, "fail");
    assert.match(wrong.summary, /deployed sha/);
    assert.match((await deployedShaGate(s.server.url, FAKE_SHA, "other")).summary, /slug/);
  } finally {
    await s.close();
  }
  const gone = await serveSite((d) => rmSync(join(d, ".well-known"), { recursive: true }));
  try {
    assert.match((await deployedShaGate(gone.server.url, FAKE_SHA, null)).summary, /HTTP 404/);
  } finally {
    await gone.close();
  }
  const noSite = await deployedShaGate(null, FAKE_SHA, null, "the build failed and no --url was given");
  assert.equal(noSite.status, "fail");
  assert.match(noSite.summary, /cannot run: the build failed/);
});

// --- routes and links -------------------------------------------------------------------------

test("routes: passes on the template, fails on a missing route and a docs index missing a section", async () => {
  const ok = await serveSite();
  try {
    assert.equal(routesGate(ok.site).status, "pass");
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => {
    rmSync(join(d, "pricing"), { recursive: true });
    edit(page(d, "docs"), (s) => s.replace(/<li><a href="\/docs\/comparison\/">Comparison<\/a><\/li>/, ""));
  });
  try {
    const g = routesGate(bad.site);
    assert.equal(g.status, "fail");
    const problems = (g.details as { problems: string[] }).problems.join("\n");
    assert.match(problems, /\/pricing\/: HTTP 404/);
    assert.match(problems, /does not link to \/docs\/comparison\//);
  } finally {
    await bad.close();
  }
  assert.equal(routesGate(null).status, "fail");
});

test("links: passes on the template, fails on a broken internal link and a missing asset", async () => {
  const ok = await serveSite();
  try {
    assert.equal((await linksGate(ok.site)).status, "pass");
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) =>
    edit(page(d, "pricing"), (s) => s.replace("</main>", '<p><a href="/docs/missing/">x</a> <img src="/logo.png" alt="logo"> <a href="https://example.com/">ext</a></p></main>')),
  );
  try {
    const g = await linksGate(bad.site);
    assert.equal(g.status, "fail");
    const broken = (g.details as { broken: { url: string; from: string[] }[] }).broken;
    assert.deepEqual(broken.map((b) => b.url), ["/docs/missing/", "/logo.png"]);
    assert.deepEqual(broken[0].from, ["/pricing/"]);
  } finally {
    await bad.close();
  }
});

// --- page structure, placeholder, noindex -----------------------------------------------------

test("page-structure: passes on the template, fails on two h1, no lang and no title", async () => {
  const ok = await serveSite();
  try {
    assert.equal(pageStructureGate(ok.site).status, "pass");
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => {
    edit(page(d, "pricing"), (s) => s.replace("</main>", "<h1>Second</h1></main>"));
    edit(page(d, "docs/architecture"), (s) => s.replace('<html lang="en">', "<html>").replace(/<title>[^<]*<\/title>/, "<title> </title>"));
  });
  try {
    const g = pageStructureGate(bad.site);
    assert.equal(g.status, "fail");
    const problems = (g.details as { problems: string[] }).problems.join("\n");
    assert.match(problems, /\/pricing\/: 2 <h1>/);
    assert.match(problems, /\/docs\/architecture\/: <html> has no lang/);
    assert.match(problems, /\/docs\/architecture\/: missing or empty <title>/);
  } finally {
    await bad.close();
  }
});

test("placeholder: passes on the template, fails on TODO, lorem and unfinished-page text", async () => {
  const ok = await serveSite();
  try {
    assert.equal(placeholderGate(ok.site).status, "pass");
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => {
    edit(page(d, ""), (s) => s.replace("</main>", "<p>TODO: write this. Lorem ipsum.</p></main>"));
    edit(page(d, "pricing"), (s) => s.replace("</main>", "<p>Each one is coming in package v1.</p></main>"));
    // Placeholder words inside a script or comment are not visible text.
    edit(page(d, "docs"), (s) => s.replace("</main>", "<!-- TODO --></main>"));
  });
  try {
    const g = placeholderGate(bad.site);
    assert.equal(g.status, "fail");
    const hits = (g.details as { hits: { page: string; pattern: string }[] }).hits.map((h) => `${h.page} ${h.pattern}`);
    assert.deepEqual(hits.sort(), ["/ TODO", "/ lorem", "/pricing/ coming in package"]);
  } finally {
    await bad.close();
  }
});

test("noindex: passes on the template, fails without _headers and without the robots meta", async () => {
  const ok = await serveSite();
  try {
    assert.equal(noindexGate(ok.site).status, "pass");
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => {
    unlinkSync(join(d, "_headers"));
    edit(page(d, "pricing"), (s) => s.replace(/<meta name="robots"[^>]*>/, ""));
  });
  try {
    const g = noindexGate(bad.site);
    assert.equal(g.status, "fail");
    const problems = (g.details as { problems: string[] }).problems;
    assert.equal(problems.filter((p) => /X-Robots-Tag/.test(p)).length, 9);
    assert.deepEqual(problems.filter((p) => /meta/.test(p)), ['/pricing/: no <meta name="robots" content="noindex">']);
  } finally {
    await bad.close();
  }
});

// --- spec samples -----------------------------------------------------------------------------

test("spec-samples: passes on the template, fails on an unknown operationId, warns with no samples", async () => {
  const ok = await serveSite();
  try {
    const g = specSamplesGate(TEMPLATE, ok.site);
    assert.equal(g.status, "pass", g.summary);
    assert.equal(g.metrics?.samples, 2);
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => edit(page(d, "docs/integration"), (s) => s.replace('data-op="getProject"', 'data-op="deleteEverything"')));
  try {
    const g = specSamplesGate(TEMPLATE, bad.site);
    assert.equal(g.status, "fail");
    assert.match(JSON.stringify(g.details), /deleteEverything/);
  } finally {
    await bad.close();
  }
  const none = await serveSite((d) => {
    for (const p of ["docs/integration", "docs/getting-started"]) edit(page(d, p), (s) => s.replace(/ data-op="[^"]*"/, ""));
  });
  try {
    assert.equal(specSamplesGate(TEMPLATE, none.site).status, "warn");
  } finally {
    await none.close();
  }
});

// --- secrets and canary -----------------------------------------------------------------------

// Built at run time so no secret-shaped string is committed to this repo.
const fakeGithubToken = ["gh", "p_", "A".repeat(36)].join("");
const fakeAwsKey = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");

test("secrets: passes on the template files, fails on token patterns without printing the value", () => {
  const { dir } = templateRepo();
  assert.equal(secretsGate(scanCorpus(dir, null)).status, "pass");
  const g = secretsGate([
    { name: "repo:a.js", text: `const t = "${fakeGithubToken}";` },
    { name: "build:b.html", text: `line\nkey=${fakeAwsKey}` },
    { name: "repo:c.env", text: `api_key: "${"x".repeat(24)}"` },
  ]);
  assert.equal(g.status, "fail");
  assert.deepEqual((g.details as { hits: unknown[] }).hits, [
    { file: "repo:a.js", line: 1, kind: "github-token" },
    { file: "build:b.html", line: 2, kind: "aws-access-key" },
    { file: "repo:c.env", line: 1, kind: "assigned-secret" },
  ]);
  assert.ok(!JSON.stringify(g).includes(fakeGithubToken));
  assert.equal(secretsGate([]).status, "fail");
});

test("canary: skip when not requested, pass when absent, fail when present without printing it", () => {
  const corpus = [{ name: "repo:a.md", text: "hello" }, { name: "deployed:/", text: "zebra-canary-77 here" }];
  assert.equal(canaryGate(null, corpus).status, "skip");
  assert.equal(canaryGate(["not-there"], corpus).status, "pass");
  const g = canaryGate(["not-there", "zebra-canary-77"], corpus);
  assert.equal(g.status, "fail");
  assert.deepEqual((g.details as { hits: unknown[] }).hits, [{ file: "deployed:/", canary: 2 }]);
  assert.ok(!JSON.stringify(g).includes("zebra-canary-77"));
  assert.equal(canaryGate([], corpus).status, "fail");
  assert.equal(canaryGate(null, corpus, "cannot read --canary-file").status, "fail");
});

// --- perf lock and Lighthouse thresholds ------------------------------------------------------

test("perf lock: exclusive, released, stale locks taken over, timeout reported", async () => {
  const path = join(tmp(), "perf.lock");
  const a = await acquireLock(path, 1000, 20);
  await assert.rejects(acquireLock(path, 100, 20), LockTimeoutError);
  a.release();
  assert.ok(!existsSync(path));
  // A lock left by a dead process on this host is stale.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  writeFileSync(path, JSON.stringify({ pid: Number(dead.stdout), host: hostname() }));
  const b = await acquireLock(path, 1000, 20);
  b.release();
});

test("lighthouse: median of runs, >= 90 pass, 85-89 warn, under 85 fail, errors fail", async () => {
  assert.equal(medianOf([97, 80, 91, 99, 90]), 91);
  assert.deepEqual([90, 89, 85, 84].map(classifyScore), ["pass", "warn", "warn", "fail"]);
  const lockPath = join(tmp(), "perf.lock");
  const fixed = (runs: LhRun[]) => {
    let i = 0;
    return async () => runs[i++ % runs.length];
  };
  const r = (performance: number, accessibility: number): LhRun => ({ performance, accessibility });
  const base = "http://127.0.0.1:1/";
  // One bad run out of five does not move the median.
  const pass = await lighthouseGate(base, ["/"], { runs: 5, lockPath, runner: fixed([r(99, 95), r(40, 95), r(98, 96), r(97, 95), r(99, 97)]) });
  assert.equal(pass.status, "pass", pass.summary);
  assert.equal(pass.metrics?.min_performance, 98);
  const warn = await lighthouseGate(base, ["/"], { runs: 5, lockPath, runner: fixed([r(99, 88)]) });
  assert.equal(warn.status, "warn");
  const fail = await lighthouseGate(base, ["/", "/docs/"], { runs: 5, lockPath, runner: fixed([r(99, 95), r(80, 95)]) });
  assert.equal(fail.status, "fail");
  const err = await lighthouseGate(base, ["/"], { runs: 5, lockPath, runner: async () => ({ performance: null, accessibility: null, error: "NO_FCP" }) });
  assert.equal(err.status, "fail");
  assert.match(JSON.stringify(err.details), /NO_FCP/);
  assert.ok(!existsSync(lockPath), "lock released");
  // Held lock: the gate fails with the reason instead of measuring.
  const held = await acquireLock(lockPath);
  const blocked = await lighthouseGate(base, ["/"], { runs: 1, lockPath, lockTimeoutMs: 50, runner: fixed([r(100, 100)]) });
  held.release();
  assert.equal(blocked.status, "fail");
  assert.match(blocked.summary, /timed out/);
});

// --- whole check, no browser ------------------------------------------------------------------

test("gate ids that carry a named cap in score.ts are not reused by deterministic gates", () => {
  const ids = ["build", "package-files", "deployed-sha", "routes", "links", "page-structure", "placeholder", "noindex", "spec-samples", "secrets", "canary", "axe", "signup-flow", "lighthouse"];
  for (const id of ids) assert.ok(!(id in CAP_GATES), id);
});

test("runCheck without a browser: browser gates fail with the reason (never pass), checks.json is valid", async () => {
  const { dir, sha } = templateRepo();
  const prev = process.env.GREENHOUSE_SKIP_BROWSER;
  process.env.GREENHOUSE_SKIP_BROWSER = "1";
  try {
    const checks = await runCheck({ repo: dir, lighthouseRuns: 1 });
    assert.equal(validate("checks", structuredClone(checks)).valid, true);
    assert.equal(checks.sha, sha);
    assert.equal(checks.slug, "example-seed");
    assert.equal(checks.all_green, false);
    const by = Object.fromEntries(checks.gates.map((g) => [g.id, g]));
    for (const id of ["build", "package-files", "deployed-sha", "routes", "links", "page-structure", "placeholder", "noindex", "spec-samples", "secrets"])
      assert.equal(by[id].status, "pass", `${id}: ${by[id].summary}`);
    assert.equal(by.canary.status, "skip");
    for (const id of ["axe", "signup-flow", "lighthouse"]) {
      assert.equal(by[id].status, "fail", id);
      assert.match(by[id].summary, /browser unavailable/);
    }
    for (const t of ["node", "playwright", "axe-core", "lighthouse", "chromium"]) assert.ok(checks.tool_versions[t], t);
  } finally {
    if (prev === undefined) delete process.env.GREENHOUSE_SKIP_BROWSER;
    else process.env.GREENHOUSE_SKIP_BROWSER = prev;
  }
});

test("runCheck: a failed build with no --url fails every site gate with the reason", async () => {
  const { dir } = templateRepo((d) => edit(join(d, "greenhouse.yaml"), (s) => s.replace("npm run build", "exit 1")));
  const checks = await runCheck({ repo: dir, lighthouseRuns: 1 });
  assert.equal(checks.all_green, false);
  for (const g of checks.gates.filter((g) => !["package-files", "secrets", "canary"].includes(g.id))) {
    assert.equal(g.status, "fail", g.id);
    if (g.id !== "build") assert.match(g.summary, /cannot run/, g.id);
  }
});

test("runCheck: --round-dir takes the sha and round from submission.yaml", async () => {
  const { dir, sha } = templateRepo();
  const round = join(tmp(), "rounds", "03");
  mkdirSync(round, { recursive: true });
  writeFileSync(
    join(round, "submission.yaml"),
    `schema_version: 1\nslug: example-seed\nround: 3\nrepo: johnmafly/example-seed\nsha: \"${sha}\"\ndeployment_url: https://example-seed.example.com/\nclaims_sha256: \"${"0".repeat(64)}\"\nchangelog: first round\n`,
  );
  const v = validate("submission", (await import("yaml")).parse(readFileSync(join(round, "submission.yaml"), "utf8")));
  assert.ok(v.valid, v.errors.join("; "));
  const prev = process.env.GREENHOUSE_SKIP_BROWSER;
  process.env.GREENHOUSE_SKIP_BROWSER = "1";
  try {
    // The submission's deployment URL does not resolve: deployed-sha fails, nothing crashes.
    const checks = await runCheck({ repo: dir, roundDir: round, url: "http://127.0.0.1:9/", lighthouseRuns: 1 });
    assert.equal(checks.round, 3);
    assert.equal(checks.sha, sha);
    assert.equal(checks.deployment_url, "http://127.0.0.1:9/");
    assert.equal(checks.gates.find((g) => g.id === "deployed-sha")?.status, "fail");
  } finally {
    if (prev === undefined) delete process.env.GREENHOUSE_SKIP_BROWSER;
    else process.env.GREENHOUSE_SKIP_BROWSER = prev;
  }
});

test("greenhouse check CLI: usage errors exit 2", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["cli/src/main.ts", "check", ...args], { encoding: "utf8" });
  assert.equal(cli().status, 2);
  assert.match(cli().stderr, /--repo is required/);
  assert.equal(cli("--repo", tmp()).status, 2);
  assert.match(cli("--repo", tmp()).stderr, /not a git repository/);
  assert.equal(cli("--help").status, 0);
});

test("greenhouse check CLI: without --out or --round-dir, writes ~/.greenhouse/checks/<slug>-<sha12>.json", () => {
  const { dir, sha } = templateRepo();
  const home = tmp();
  const r = spawnSync(process.execPath, ["cli/src/main.ts", "check", "--repo", dir, "--lighthouse-runs", "1"], {
    encoding: "utf8",
    env: { ...process.env, GREENHOUSE_HOME: home, GREENHOUSE_SKIP_BROWSER: "1" },
  });
  // No browser: axe, signup-flow and lighthouse fail with the reason, so the exit is 1.
  assert.equal(r.status, 1, r.stderr);
  const out = join(home, "checks", `example-seed-${sha.slice(0, 12)}.json`);
  assert.ok(existsSync(out), r.stderr);
  assert.ok(validate("checks", JSON.parse(readFileSync(out, "utf8"))).valid);
  assert.ok(!existsSync(join(dir, "checks.json")), "nothing written into the project repo");
});
