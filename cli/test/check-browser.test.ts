// Browser gates (axe, signup flow, Lighthouse) and the full CLI run. They need the pinned
// Playwright Chromium; where it is not installed (e.g. GitHub CI) each test is skipped with the
// marker "SKIP(browser)" and the reason. Run them on the Mac mini: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { validate } from "../src/lib/schemas.ts";
import { axeGate, browserAvailable, launchBrowser, signupGate } from "../src/check/browser.ts";
import { lighthouseGate } from "../src/check/lighthouse.ts";
import { htmlPages } from "../src/check/site.ts";
import { edit, serveSite, stubSignup, templateRepo, tmp } from "./check-helpers.ts";

const avail = await browserAvailable();
const skip = avail.ok ? false : `SKIP(browser): ${avail.reason}`;
if (skip) process.stdout.write(`# ${skip}\n`);

let browser: Browser | null = null;
const getBrowser = async () => (browser ??= await launchBrowser());
test.after(async () => {
  await browser?.close();
});

const signupFile = (d: string) => join(d, "signup", "index.html");

test("axe: passes on the template, fails on a critical violation", { skip }, async () => {
  const ok = await serveSite();
  try {
    const g = await axeGate(await getBrowser(), ok.server.url, htmlPages(ok.site).map((p) => p.path));
    assert.equal(g.status, "pass", g.summary);
  } finally {
    await ok.close();
  }
  // An image with no alt text is a critical axe violation (image-alt).
  const bad = await serveSite((d) => edit(join(d, "pricing", "index.html"), (s) => s.replace("</main>", '<img src="/favicon.ico"></main>')));
  try {
    const g = await axeGate(await getBrowser(), bad.server.url, ["/", "/pricing/"]);
    assert.equal(g.status, "fail", g.summary);
    assert.equal(g.metrics?.critical, 1);
    assert.match(JSON.stringify(g.details), /image-alt/);
  } finally {
    await bad.close();
  }
});

test("signup-flow: passes on the template, fails on a stub, a final screen without 'preview', and storage", { skip }, async () => {
  const b = await getBrowser();
  const ok = await serveSite();
  try {
    const g = await signupGate(b, ok.server.url);
    assert.equal(g.status, "pass", g.summary);
    assert.deepEqual((g.details as { steps: string[] }).steps, ["Continue", "Create project"]);
  } finally {
    await ok.close();
  }
  const stub = await serveSite(stubSignup);
  try {
    const g = await signupGate(b, stub.server.url);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /no way forward on step 1/);
  } finally {
    await stub.close();
  }
  const noPreview = await serveSite((d) => edit(signupFile(d), (s) => s.replace("This is a preview: nothing", "Nothing")));
  try {
    assert.match((await signupGate(b, noPreview.server.url)).summary, /does not say it is a preview/);
  } finally {
    await noPreview.close();
  }
  // [data-next] is accepted as the forward control.
  const alias = await serveSite((d) => edit(signupFile(d), (s) => s.replaceAll("data-signup-next", "data-next")));
  try {
    assert.equal((await signupGate(b, alias.server.url)).status, "pass");
  } finally {
    await alias.close();
  }
  // A flow that walks its steps but never marks a final screen fails with the fix in the summary.
  const unmarked = await serveSite((d) => edit(signupFile(d), (s) => s.replace("<section data-signup-final", "<section data-step=\"3\"")));
  try {
    const g = await signupGate(b, unmarked.server.url);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /stopped after 2 steps: .*data-signup-final/);
  } finally {
    await unmarked.close();
  }
  const stores = await serveSite((d) => edit(signupFile(d), (s) => s.replace("current.hidden = true;", 'current.hidden = true; localStorage.setItem("email", "x");')));
  try {
    const g = await signupGate(b, stores.server.url);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /stores data: 1 localStorage/);
  } finally {
    await stores.close();
  }
});

test("lighthouse (real, 1 run): template passes, an inaccessible page fails", { skip }, async () => {
  const lockPath = join(tmp(), "perf.lock");
  const ok = await serveSite();
  try {
    const g = await lighthouseGate(ok.server.url, ["/"], { runs: 1, lockPath });
    assert.equal(g.status, "pass", g.summary);
  } finally {
    await ok.close();
  }
  // No lang, no title, unlabeled inputs, images without alt, unreadable contrast.
  const bad = await serveSite((d) =>
    edit(join(d, "pricing", "index.html"), () =>
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, user-scalable=no, maximum-scale=1"></head><body>` +
        `<div style="color:#eee;background:#fff">${"<p>low contrast text</p>".repeat(5)}</div>` +
        `${'<img src="/x.png">'.repeat(5)}${'<input type="text">'.repeat(5)}<button></button><a href="/"></a></body></html>`,
    ),
  );
  try {
    const g = await lighthouseGate(bad.server.url, ["/pricing/"], { runs: 1, lockPath });
    assert.equal(g.status, "fail", g.summary);
    assert.ok(Number(g.metrics?.min_accessibility) < 85, String(g.metrics?.min_accessibility));
  } finally {
    await bad.close();
  }
});

test("greenhouse check CLI: the template is all green and writes a valid checks.json", { skip }, () => {
  const { dir, sha } = templateRepo();
  const out = join(tmp(), "checks.json");
  const r = spawnSync(process.execPath, ["cli/src/main.ts", "check", "--repo", dir, "--out", out, "--lighthouse-runs", "1"], {
    encoding: "utf8",
    env: { ...process.env, GREENHOUSE_HOME: tmp() },
  });
  assert.equal(r.status, 0, r.stderr);
  const checks = JSON.parse(readFileSync(out, "utf8"));
  const v = validate("checks", checks);
  assert.ok(v.valid, v.errors.join("; "));
  assert.equal(checks.sha, sha);
  assert.equal(checks.all_green, true);
  assert.deepEqual(
    checks.gates.filter((g: { status: string }) => g.status !== "pass").map((g: { id: string; status: string }) => `${g.id}:${g.status}`),
    ["canary:skip"],
  );
});

test("greenhouse check CLI: a stub package reports its failures and exits 1", { skip }, () => {
  const { dir } = templateRepo((d) => {
    stubSignup(join(d, "site"));
    edit(join(d, "site", "index.html"), (s) => s.replace("</main>", "<p>The introduction site is coming in package v1.</p></main>"));
  });
  const out = join(tmp(), "checks.json");
  const canary = join(tmp(), "canary.txt");
  spawnSync("sh", ["-c", `printf '# canaries\\ncoming in package v1\\n' > '${canary}'`]);
  const r = spawnSync(process.execPath, ["cli/src/main.ts", "check", "--repo", dir, "--out", out, "--canary-file", canary, "--lighthouse-runs", "1"], {
    encoding: "utf8",
    env: { ...process.env, GREENHOUSE_HOME: tmp() },
  });
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(validate("checks", checks).valid);
  const failed = checks.gates.filter((g: { status: string }) => g.status === "fail").map((g: { id: string }) => g.id);
  assert.deepEqual(failed, ["placeholder", "canary", "signup-flow"]);
  assert.match(r.stderr, /FAILED: placeholder, canary, signup-flow/);
});
