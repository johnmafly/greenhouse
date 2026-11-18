// Browser gates (axe, signup flow, Lighthouse) and the full CLI run. They need the pinned
// Playwright Chromium; where it is not installed (e.g. GitHub CI) each test is skipped with the
// marker "SKIP(browser)" and the reason. Run them on the Mac mini: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { validate } from "../src/lib/schemas.ts";
import { parse as parseYaml } from "yaml";
import { axeGate, browserAvailable, isCloudflareRum, launchBrowser, signupGate } from "../src/check/browser.ts";
import { contentSections, parseContentMap } from "../src/check/content.ts";
import { noJsContentGate, reducedMotionGate } from "../src/check/motion.ts";
import { lighthouseGate } from "../src/check/lighthouse.ts";
import { htmlPages } from "../src/check/site.ts";
import { launchWebkit, webkitAvailable, webkitIphoneGate } from "../src/check/webkit.ts";
import { TEMPLATE, edit, serveSite, stubSignup, templateRepo, tmp } from "./check-helpers.ts";

const avail = await browserAvailable();
const skip = avail.ok ? false : `SKIP(browser): ${avail.reason}`;
if (skip) process.stdout.write(`# ${skip}\n`);

// WebKit is checked on its own (CI installs WebKit but not Chromium): marker "SKIP(webkit)".
const wkAvail = await webkitAvailable();
const wkSkip = wkAvail.ok ? false : `SKIP(webkit): ${wkAvail.reason}`;
if (wkSkip) process.stdout.write(`# ${wkSkip}\n`);

let browser: Browser | null = null;
const getBrowser = async () => (browser ??= await launchBrowser());
let webkitBrowser: Browser | null = null;
const getWebkit = async () => (webkitBrowser ??= await launchWebkit());
test.after(async () => {
  await browser?.close();
  await webkitBrowser?.close();
});

/** A strict CSP on every page (inline scripts blocked), as real sites ship it. */
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const withCsp = (d: string) => edit(join(d, "_headers"), (s) => `${s}\n/*\n  Content-Security-Policy: ${STRICT_CSP}\n`);

const signupFile = (d: string) => join(d, "signup", "index.html");
const templateSections = () => contentSections(parseContentMap(parseYaml(readFileSync(join(TEMPLATE, "greenhouse.yaml"), "utf8"))));

/** Home page with extra CSS/JS and three tall sections (so the page scrolls). */
function home(css: string, js = "", sectionClass = "reveal"): (d: string) => void {
  const sections = ["Meter every request", "Watch the budget", "Ship the policy"]
    .map((h, i) => `<section class="${sectionClass}" id="s${i}" style="min-height:900px"><h2>${h}</h2><p>Section ${i + 1} explains one part of the product in plain words.</p><div class="art" id="art${i}">art</div></section>`)
    .join("");
  return (d) =>
    edit(join(d, "index.html"), (s) =>
      s.replace("</head>", `<style>${css}</style></head>`).replace("</main>", `${sections}</main>${js ? `<script>${js}</script>` : ""}`),
    );
}
const REVEAL_JS = `const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")));
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));`;
/** Motion done right: only with no-preference, and hidden only once a script has run. */
const GOOD_MOTION = home(
  `@media (prefers-reduced-motion: no-preference) {
     .art { animation: float 3s ease-in-out infinite; }
     html.js .reveal { opacity: 0; transform: translateY(24px); transition: opacity .6s, transform .6s; }
     html.js .reveal.in { opacity: 1; transform: none; }
   }
   @keyframes float { 50% { transform: translateY(-8px); } }`,
  `document.documentElement.classList.add("js");\n${REVEAL_JS}`,
);
/** Scroll reveal that starts at opacity 0 in CSS and animates regardless of reduced motion. */
const SCROLL_REVEAL = home(
  `.reveal { opacity: 0; transform: translateY(24px); transition: opacity .6s, transform .6s; }
   .reveal.in { opacity: 1; transform: none; }`,
  REVEAL_JS,
);

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

test("axe under a strict CSP (script-src 'self'): runs and passes a clean page, fails a real violation", { skip }, async () => {
  const ok = await serveSite(withCsp);
  try {
    const res = await fetch(new URL("pricing/", ok.server.url));
    assert.equal(res.headers.get("content-security-policy"), STRICT_CSP, "the fixture serves the CSP");
    const g = await axeGate(await getBrowser(), ok.server.url, ["/", "/pricing/"]);
    assert.equal(g.status, "pass", g.summary);
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => {
    withCsp(d);
    edit(join(d, "pricing", "index.html"), (s) => s.replace("</main>", '<img src="/favicon.ico"></main>'));
  });
  try {
    const g = await axeGate(await getBrowser(), bad.server.url, ["/", "/pricing/"]);
    assert.equal(g.status, "fail", g.summary);
    assert.doesNotMatch(g.summary, /cannot run/);
    assert.match(JSON.stringify(g.details), /image-alt/);
  } finally {
    await bad.close();
  }
});

test("webkit-iphone: the template renders in WebKit with a screenshot per route; Chromium comparison when available", { skip: wkSkip }, async () => {
  const ok = await serveSite(withCsp);
  const evidence = tmp();
  try {
    const chromium = avail.ok ? await getBrowser() : null;
    const g = await webkitIphoneGate(ok.server.url, ["/", "/pricing/", "/docs/how-it-works/"], "x", { evidenceDir: evidence, chromium, webkit: await getWebkit() });
    assert.equal(g.status, "pass", `${g.summary} ${JSON.stringify(g.details)}`);
    assert.equal(g.metrics?.screenshots, 3);
    for (const f of ["home", "pricing", "docs-how-it-works"]) assert.ok(readFileSync(join(evidence, "webkit-iphone", `${f}.png`)).length > 1000, f);
    const d = g.details as { device: string; routes: { h1_font: unknown }[] };
    assert.equal(d.device, "iPhone 15 Pro");
    if (chromium) assert.ok(d.routes[0].h1_font, "computed-style comparison ran");
  } finally {
    await ok.close();
  }
});

test("webkit-iphone: fails on a stylesheet that 404s, an empty stylesheet, a page error and a font that does not load", { skip: wkSkip }, async () => {
  const cases: [string, (d: string) => void, RegExp][] = [
    ["css 404", (d) => edit(join(d, "index.html"), (s) => s.replace("</head>", '<link rel="stylesheet" href="/assets/missing.css"></head>')), /request failed: \/assets\/missing\.css \(status 404\)/],
    [
      "empty css",
      (d) => {
        mkdirSync(join(d, "assets"), { recursive: true });
        writeFileSync(join(d, "assets", "site.css"), "/* nothing */");
        edit(join(d, "index.html"), (s) => s.replace("</head>", '<link rel="stylesheet" href="/assets/site.css"></head>'));
      },
      /stylesheet has no CSS rules: \/assets\/site\.css/,
    ],
    [
      "page error",
      (d) => {
        mkdirSync(join(d, "assets"), { recursive: true });
        writeFileSync(join(d, "assets", "boom.js"), "window.addEventListener('load', () => { throw new Error('boom in safari'); });");
        edit(join(d, "index.html"), (s) => s.replace("</head>", '<script src="/assets/boom.js"></script></head>'));
      },
      /page error: .*boom in safari/,
    ],
    [
      "font",
      (d) => {
        mkdirSync(join(d, "assets"), { recursive: true });
        writeFileSync(join(d, "assets", "brand.woff2"), "not a font");
        writeFileSync(join(d, "assets", "site.css"), "@font-face { font-family: Brand; src: url(/assets/brand.woff2) format('woff2'); } h1 { font-family: Brand, serif }");
        edit(join(d, "index.html"), (s) => s.replace("</head>", '<link rel="stylesheet" href="/assets/site.css"></head>'));
      },
      /font did not load: brand \(error\)/,
    ],
  ];
  for (const [name, mutate, re] of cases) {
    const s = await serveSite(mutate);
    try {
      const g = await webkitIphoneGate(s.server.url, ["/"], "x", { webkit: await getWebkit() });
      assert.equal(g.status, "fail", `${name}: ${g.summary}`);
      assert.match(JSON.stringify(g.details), re, name);
    } finally {
      await s.close();
    }
  }
  assert.match((await webkitIphoneGate(null, ["/"], "the build failed")).summary, /cannot run: the build failed/);
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

test("signup-flow: ignores Cloudflare's same-origin POST /cdn-cgi/rum, fails on any other non-GET", { skip }, async () => {
  assert.equal(isCloudflareRum("POST", "https://a.example/cdn-cgi/rum?", "https://a.example"), true);
  assert.equal(isCloudflareRum("POST", "https://b.example/cdn-cgi/rum", "https://a.example"), false);
  assert.equal(isCloudflareRum("PUT", "https://a.example/cdn-cgi/rum", "https://a.example"), false);
  assert.equal(isCloudflareRum("POST", "https://a.example/cdn-cgi/rumx", "https://a.example"), false);
  const b = await getBrowser();
  const beacon = (path: string) => (d: string) =>
    edit(signupFile(d), (s) => s.replace("</body>", `<script>navigator.sendBeacon(${JSON.stringify(path)}, "{}");</script></body>`));
  const rum = await serveSite(beacon("/cdn-cgi/rum"));
  try {
    const g = await signupGate(b, rum.server.url);
    assert.equal(g.status, "pass", g.summary);
    assert.match(g.summary, /ignored 1 Cloudflare Web Analytics beacon/);
    assert.match(JSON.stringify(g.details), /POST http:\/\/127\.0\.0\.1:\d+\/cdn-cgi\/rum/);
  } finally {
    await rum.close();
  }
  const other = await serveSite(beacon("/api/track"));
  try {
    const g = await signupGate(b, other.server.url);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /signup sends data: POST .*\/api\/track/);
  } finally {
    await other.close();
  }
  // The signup start comes from content.signup.
  const moved = await serveSite((d) => {
    const html = readFileSync(signupFile(d), "utf8");
    rmSync(join(d, "signup"), { recursive: true });
    mkdirSync(join(d, "try"));
    writeFileSync(join(d, "try", "index.html"), html);
  });
  try {
    assert.equal((await signupGate(b, moved.server.url)).status, "fail");
    const g = await signupGate(b, moved.server.url, "x", 12, "/try/");
    assert.equal(g.status, "pass", g.summary);
    assert.match(g.summary, /from \/try\//);
  } finally {
    await moved.close();
  }
});

test("reduced-motion: passes on the template and on motion gated by no-preference; fails when motion ignores it", { skip }, async () => {
  const b = await getBrowser();
  for (const [name, mutate] of [["template", undefined], ["gated motion", GOOD_MOTION]] as const) {
    const s = await serveSite(mutate);
    try {
      const g = await reducedMotionGate(b, s.server.url);
      assert.equal(g.status, "pass", `${name}: ${g.summary} ${JSON.stringify(g.details)}`);
    } finally {
      await s.close();
    }
  }
  const cases: [string, (d: string) => void, RegExp][] = [
    ["infinite animation", home(".art { animation: spin 2s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }", "", "plain"), /animation\(s\) longer than 200 ms/],
    ["600 ms scroll reveal", SCROLL_REVEAL, /animation\(s\) longer than 200 ms/],
    ["CSS scroll-driven", home(".art { animation: grow linear both; animation-timeline: view(); } @keyframes grow { from { transform: scale(.5); } }", "", "plain"), /scroll-linked/],
    ["JS parallax", home("", `addEventListener("scroll", () => document.querySelectorAll(".art").forEach((el) => (el.style.transform = "translateY(" + scrollY * 0.3 + "px)")));`, "plain"), /scroll-linked/],
    ["JS tween", home("", `const el = document.getElementById("art0"); const t0 = performance.now(); (function f(t) { el.style.opacity = String(0.5 + 0.5 * Math.sin((t - t0) / 300)); requestAnimationFrame(f); })(t0);`, "plain"), /still moving 250 ms after a scroll/],
    ["hidden text", home(".art { opacity: 0; }", "", "plain"), /text element\(s\) in view but invisible/],
  ];
  for (const [name, mutate, re] of cases) {
    const s = await serveSite(mutate);
    try {
      const g = await reducedMotionGate(b, s.server.url);
      assert.equal(g.status, "fail", `${name}: ${g.summary}`);
      assert.match(g.summary, re, name);
    } finally {
      await s.close();
    }
  }
  assert.equal((await reducedMotionGate(null, null, "no browser")).status, "fail");
});

test("no-js-content: passes on the template and on script-gated reveals; fails on CSS opacity:0 scroll reveal", { skip }, async () => {
  const b = await getBrowser();
  const sections = templateSections();
  for (const [name, mutate] of [["template", undefined], ["script-gated reveal", GOOD_MOTION]] as const) {
    const s = await serveSite(mutate);
    try {
      const g = await noJsContentGate(b, s.server.url, sections);
      assert.equal(g.status, "pass", `${name}: ${g.summary}`);
      assert.equal(g.metrics?.sections, 8);
    } finally {
      await s.close();
    }
  }
  const bad = await serveSite(SCROLL_REVEAL);
  try {
    const g = await noJsContentGate(b, bad.server.url, sections);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /home \(\d+ text element\(s\) invisible without JavaScript/);
    assert.equal(g.metrics?.failing, 1);
  } finally {
    await bad.close();
  }
  // An anchor that does not exist, and a page that renders its text only from a script.
  const scripted = await serveSite((d) =>
    edit(join(d, "pricing", "index.html"), (s) => s.replace(/<main>[\s\S]*<\/main>/, '<main id="app"></main><script>document.getElementById("app").innerHTML = "<h1>Pricing</h1><p>Free and paid.</p>";</script>')),
  );
  try {
    const g = await noJsContentGate(b, scripted.server.url, [
      { label: "pricing", path: "/pricing/", anchor: null },
      { label: "plans", path: "/", anchor: "plans" },
    ]);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /pricing \(no visible text without JavaScript\)/);
    assert.match(g.summary, /plans \(#plans not found without JavaScript\)/);
  } finally {
    await scripted.close();
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

test("greenhouse check CLI: the template passes every gate but template-likeness (it is the template) and writes a valid checks.json", { skip }, () => {
  const { dir, sha } = templateRepo();
  const out = join(tmp(), "checks.json");
  const r = spawnSync(process.execPath, ["cli/src/main.ts", "check", "--repo", dir, "--out", out, "--lighthouse-runs", "1"], {
    encoding: "utf8",
    env: { ...process.env, GREENHOUSE_HOME: tmp() },
  });
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(readFileSync(out, "utf8"));
  const v = validate("checks", checks);
  assert.ok(v.valid, v.errors.join("; "));
  assert.equal(checks.sha, sha);
  assert.deepEqual(
    checks.gates.map((g: { id: string }) => g.id),
    ["build", "package-files", "claim-links", "deployed-sha", "routes", "links", "page-structure", "placeholder", "product-voice", "noindex", "spec-samples", "template-likeness", "secrets", "canary", "asset-cache", "axe", "signup-flow", "reduced-motion", "no-js-content", "webkit-iphone", "lighthouse"],
  );
  assert.deepEqual(
    checks.gates.filter((g: { status: string }) => g.status !== "pass").map((g: { id: string; status: string }) => `${g.id}:${g.status}`),
    ["template-likeness:fail", "canary:skip"],
  );
  assert.equal(checks.gates.find((g: { id: string }) => g.id === "template-likeness").metrics.template_similarity, 1);
  // Lighthouse ran on / plus the content paths (7 here, all different).
  assert.equal(checks.gates.find((g: { id: string }) => g.id === "lighthouse").details.routes.length, 8);
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
  assert.deepEqual(failed, ["placeholder", "template-likeness", "canary", "signup-flow"]);
  assert.match(r.stderr, /FAILED: placeholder, template-likeness, canary, signup-flow/);
});
