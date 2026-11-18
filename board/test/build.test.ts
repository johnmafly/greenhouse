import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard } from "../build.ts";
import { BoardInputError } from "../src/data.ts";
import { INLINE_SCRIPT } from "../src/render.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const PORTFOLIO = join(FIXTURES, "portfolio");
const OPS = join(FIXTURES, "ops");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = "2026-11-18T12:00:00Z";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gh-board-"));
}

function build(opts: { portfolioDir?: string; opsDir?: string; now?: string } = {}) {
  const outDir = join(tmp(), "dist");
  const r = buildBoard({
    portfolioDir: opts.portfolioDir ?? PORTFOLIO,
    opsDir: opts.opsDir ?? OPS,
    outDir,
    env: { CF_PAGES_COMMIT_SHA: SHA },
    now: opts.now ?? NOW,
  });
  const read = (rel: string) => readFileSync(join(outDir, rel), "utf8");
  return { ...r, outDir, read };
}

function htmlFiles(dir: string, base = ""): string[] {
  return readdirSync(join(dir, base)).flatMap((f) => {
    const rel = join(base, f);
    if (statSync(join(dir, rel)).isDirectory()) return htmlFiles(dir, rel);
    return rel.endsWith(".html") ? [rel] : [];
  });
}

test("builds every route from fixtures", () => {
  const b = build();
  for (const f of [
    "index.html", "projects/tidepool/index.html", "projects/ferncast/index.html", "projects/mossbank/index.html",
    "projects/seedling/index.html", "judge/index.html", "ops/index.html", "404.html", ".well-known/greenhouse.json",
    "_headers", "assets/board.css", "favicon.svg",
  ]) {
    assert.ok(existsSync(join(b.outDir, f)), `missing ${f}`);
  }
});

test("every page is mobile-ready, noindex, self-contained and has one h1", () => {
  const b = build();
  const pages = htmlFiles(b.outDir);
  assert.ok(pages.length >= 8);
  for (const p of pages) {
    const html = b.read(p);
    assert.match(html, /<html lang="en">/, p);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, p);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, p);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, `${p} has one h1`);
    assert.doesNotMatch(html, /<script[^>]+src=/i, `${p} loads no script file`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i, `${p} loads no remote stylesheet`);
    assert.doesNotMatch(html, /<(img|iframe)[^>]+src="https?:/i, `${p} embeds nothing remote`);
    assert.doesNotMatch(html, /\sstyle="/i, `${p} has no inline style attributes (blocked by the CSP)`);
    assert.doesNotMatch(html, /\son[a-z]+="/i, `${p} has no inline event handlers`);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, [INLINE_SCRIPT], `${p} has only the known inline script`);
  }
});

test("_headers keeps noindex first and allows the inline script by hash only", () => {
  const b = build();
  const headers = b.read("_headers");
  const lines = headers.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.equal(lines[0], "/*");
  assert.match(lines[1], /^\s+X-Robots-Tag:\s*noindex\b/i);
  const hash = createHash("sha256").update(INLINE_SCRIPT).digest("base64");
  const csp = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), "CSP script hash matches the inline script");
  assert.doesNotMatch(csp, /unsafe-inline/);
});

test(".well-known/greenhouse.json carries the Pages commit sha and build time", () => {
  const b = build();
  assert.deepEqual(JSON.parse(b.read(".well-known/greenhouse.json")), { slug: "greenhouse", sha: SHA, built_at: NOW });
});

test("404.html is a real page, not the leaderboard", () => {
  const b = build();
  const html = b.read("404.html");
  assert.match(html, /Nothing grows here/);
  assert.doesNotMatch(html, /From seed to graduation/);
});

test("leaderboard sorts by score, shows provisional, momentum and next action", () => {
  const html = build().read("index.html");
  const order = ["Tidepool", "Ferncast", "Mossbank", "Seedling"].map((n) => html.indexOf(`>${n}</a></h2>`));
  assert.ok(order.every((i) => i > 0), "all projects listed");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sorted by composite, unscored last");
  assert.match(html, /Provisional/);
  assert.match(html, />8\.95</);
  assert.match(html, /\+1\.95<\/span>\/round/, "points gained per round");
  assert.match(html, /\$21\.20<\/span> of \$150/, "spend of cap");
  assert.match(html, /2 of 6/, "rounds used of budget");
  assert.match(html, /capped/, "Ferncast is capped by its failed gate");
  assert.match(html, /Awaiting first round/);
  assert.match(html, /Round 01 submitted\. Judge runs the gates\./);
  assert.match(html, /<svg class="trend"[^>]*aria-label="Composite by round: round 1 7\.00, round 2 8\.95"/);
});

test("a project with zero rounds renders as awaiting its first round", () => {
  const html = build().read("projects/seedling/index.html");
  assert.match(html, /<h2>Awaiting first round<\/h2>/);
  assert.match(html, /No scored rounds yet/);
});

test("project page shows every round, ruling as rendered markdown, findings and evidence hash", () => {
  const html = build().read("projects/tidepool/index.html");
  assert.ok(html.indexOf('id="round-02"') < html.indexOf('id="round-01"'), "newest round first");
  assert.match(html, /<h4>Ruling: revise<\/h4>/);
  assert.match(html, /<strong>8\.95<\/strong>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /Comparison omits the incumbent/);
  assert.match(html, /Must change/);
  const bundle = JSON.parse(readFileSync(join(PORTFOLIO, "tidepool/rounds/02/checks.json"), "utf8")).bundle_hash;
  assert.ok(html.includes(`title="${bundle}"`), "evidence bundle hash shown");
  assert.match(html, /private evidence store/);
  assert.match(html, /href="https:\/\/tidepool\.agenthatch\.ai"/);
  assert.match(html, /href="https:\/\/github\.com\/johnmafly\/tidepool-site"/);
});

test("judge report card lists tests 1 to 6 as not yet run and the versions in force", () => {
  const html = build().read("judge/index.html");
  assert.match(html, /The judge is provisional\./);
  for (const name of ["Agreement with you", "Planted defects", "Repeatability", "Gaming", "History-blindness", "Live acceptance"]) {
    assert.ok(html.includes(name), name);
  }
  assert.equal(html.match(/Not yet run/g)?.length, 6);
  assert.match(html, /v1: 8 dimensions/);
  assert.match(html, /brief-v1/);
});

test("ops: sweep within 36 hours is healthy, older or missing is red; open rounds listed", () => {
  const fresh = build({ now: "2026-11-18T12:00:00Z" }).read("ops/index.html");
  assert.match(fresh, /class="card card-fresh" data-sweep-at="2026-11-18T06:00:00Z"/);
  assert.match(fresh, /health health-fresh/);
  assert.match(fresh, /Mossbank<\/a><\/td><td class="num">01/);

  const stale = build({ now: "2026-11-19T18:01:00Z" }).read("ops/index.html");
  assert.match(stale, /card card-stale/);
  assert.match(stale, /health health-stale/);

  const none = build({ opsDir: join(tmp(), "no-ops") });
  assert.match(none.read("ops/index.html"), /No sweep has written/);
  assert.match(none.read("index.html"), /health health-stale[^"]*" href="\/ops\/"><span class="dot"><\/span>Sweep: none recorded yet/);
});

function tamperedCopy(): string {
  const dir = join(tmp(), "portfolio");
  cpSync(PORTFOLIO, dir, { recursive: true });
  return dir;
}

test("refuses to build when checks.json does not match score.json's hash", () => {
  const dir = tamperedCopy();
  const p = join(dir, "tidepool/rounds/02/checks.json");
  writeFileSync(p, readFileSync(p, "utf8").replace("Median performance 88", "Median performance 98"));
  assert.throws(() => build({ portfolioDir: dir }), (e: unknown) => {
    assert.ok(e instanceof BoardInputError);
    assert.match(e.message, /tidepool\/rounds\/02\/score\.json: inputs\.checks_sha256 .* does not match checks\.json/);
    return true;
  });
});

test("refuses to build when a review does not match, and the CLI exits 1 without writing", () => {
  const dir = tamperedCopy();
  const p = join(dir, "ferncast/rounds/01/reviews/2.json");
  writeFileSync(p, readFileSync(p, "utf8").replace('"conviction": 8', '"conviction": 9'));
  const out = join(tmp(), "dist");
  const res = spawnSync(process.execPath, ["board/build.ts", "--portfolio", dir, "--ops", OPS, "--out", out], { encoding: "utf8" });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /refusing to build/);
  assert.match(res.stderr, /inputs\.reviews_sha256\["2\.json"\] does not match reviews\/2\.json/);
  assert.equal(existsSync(out), false, "nothing written");
});

test("refuses unscored reviews, missing reviews and invalid inputs", () => {
  const dir = tamperedCopy();
  rmSync(join(dir, "tidepool/rounds/01/reviews/3.json"));
  writeFileSync(join(dir, "tidepool/rounds/02/reviews/4.json"), readFileSync(join(dir, "tidepool/rounds/02/reviews/1.json")));
  writeFileSync(join(dir, "seedling/intake.yaml"), readFileSync(join(dir, "seedling/intake.yaml"), "utf8").replace("status: seed", "status: sprouting"));
  assert.throws(() => build({ portfolioDir: dir }), (e: unknown) => {
    assert.ok(e instanceof BoardInputError);
    assert.match(e.message, /lists reviews\/3\.json, which is missing/);
    assert.match(e.message, /reviews\/4\.json is not among the scored inputs/);
    assert.match(e.message, /seedling\/intake\.yaml is invalid/);
    return true;
  });
});

test("the committed portfolio builds (real data, e.g. BotRampart with no rounds)", () => {
  const outDir = join(tmp(), "dist");
  const r = buildBoard({ outDir, env: { CF_PAGES_COMMIT_SHA: SHA }, now: NOW });
  const slugs = readdirSync(join(import.meta.dirname, "..", "..", "portfolio")).filter((d) =>
    existsSync(join(import.meta.dirname, "..", "..", "portfolio", d, "intake.yaml")),
  );
  for (const s of slugs) assert.ok(r.files.includes(`projects/${s}/index.html`), s);
});
