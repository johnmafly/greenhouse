// Decision 0008: vision-first (rule 1) and the product-site playbook (rule 2). Static gates:
// product-voice's rule-1 forms, mock-figures, same-ctas, menu-footer-parity; claim-sweep skipping
// listed sample figures. The browser gate (no-scroll-reveal) is in check-browser.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sweepCandidates } from "../src/check/assisted.ts";
import { MOCK_FILE, SAMPLE_NOTE, isListedMock, mockFiguresGate, mockOnPage, numbersIn, parseMockFigures } from "../src/check/mock.ts";
import { ctaLabel, menuFooterGate, sameCtasGate } from "../src/check/playbook.ts";
import { PENDING_CELLS, VOICE_EXEMPT, VOICE_LIST, pageVoiceSources, productVoiceGate, voiceHits } from "../src/check/voice.ts";
import { TEMPLATE, edit, serveSite, tmp } from "./check-helpers.ts";

const page = (dir: string, route: string) => join(dir, route, "index.html");
const hit = (text: string) => voiceHits([{ source: "/", where: "text", text }]).map((h) => h.match);

/** The rule-1 forms decision 0008 adds to the product-voice list (exact strings). */
const RULE1_FORMS = [
  "coming next",
  "not available yet",
  "not yet available",
  "not measured yet",
  "not yet measured",
  "results pending",
  "result pending",
  "pending results",
  "until results land",
  "until the results land",
  "waiting for results",
  "waiting for the results",
  "awaiting results",
];

// --- product-voice: rule 1 -------------------------------------------------------------------

test("product-voice: every rule-1 form is listed and fails on its own, case-insensitive", () => {
  const forms = VOICE_LIST.flatMap(([, f]) => f);
  for (const f of RULE1_FORMS) {
    assert.ok(forms.includes(f), `${f} is listed`);
    assert.deepEqual(hit(`Exports: ${f.toUpperCase()}.`), [f], f);
  }
  // The decision 0005 list is kept.
  for (const f of ["by design", "planned", "proposal", "demo", "mockup", "prototype", "roadmap", "coming soon", "illustrative"]) assert.ok(forms.includes(f), f);
  for (const s of ["Available today on every plan.", "Measured on every request.", "Results land in your dashboard in 2 seconds.", "Pending requests are queued, never dropped."])
    assert.deepEqual(hit(s), [], s);
});

test('product-voice: "Get a demo" (the rule-2 call to action) passes; other demo wording still fails', () => {
  assert.deepEqual(VOICE_EXEMPT, ["get a demo"]);
  assert.deepEqual(hit("Get a demo"), []);
  assert.deepEqual(hit("GET A DEMO →"), []);
  assert.deepEqual(hit("Book a demo"), ["demo"]);
  assert.deepEqual(hit("Get a demo of the demo site"), ["demo"]);
  assert.deepEqual(hit("Watch the demos"), ["demos"]);
});

test("product-voice: a table cell that only says a result is pending fails", () => {
  const html = `<table><tr><th>Engine</th><th>Detection</th></tr><tr><td>Ours</td><td>Pending</td></tr><tr><td>Theirs</td><td>TBD</td></tr><tr><td>Other</td><td>In progress…</td></tr><tr><td>Fine</td><td>Pending requests drop to 0</td></tr></table>`;
  const hits = voiceHits(pageVoiceSources(html, "/bench/")).filter((h) => h.pattern === "pending cell");
  assert.deepEqual(hits.map((h) => h.match), ["pending", "tbd", "in progress"]);
  for (const c of ["pending", "in progress", "tbd", "measuring", "awaiting results"]) assert.ok(PENDING_CELLS.includes(c), c);
});

test("product-voice gate: the template passes; a rule-1 phrase on a page fails", async () => {
  const ok = await serveSite();
  try {
    const g = await productVoiceGate(ok.site);
    assert.equal(g.status, "pass", JSON.stringify(g.details));
  } finally {
    await ok.close();
  }
  const bad = await serveSite((d) => edit(page(d, "pricing"), (s) => s.replace("</main>", "<p>Team analytics is not available yet; benchmark results pending.</p><table><tr><td>p99</td><td>Measuring</td></tr></table></main>")));
  try {
    const g = await productVoiceGate(bad.site);
    assert.equal(g.status, "fail");
    const matches = (g.details as { hits: { match: string }[] }).hits.map((h) => h.match).sort();
    assert.deepEqual(matches, ["measuring", "not available yet", "results pending"]);
  } finally {
    await bad.close();
  }
});

// --- mock-figures ----------------------------------------------------------------------------

const BENCH = (note = `<figcaption>${SAMPLE_NOTE}.</figcaption>`) =>
  `<figure data-mock><table><tr><th>Engine</th><th>Bots stopped</th></tr><tr><td>Ours</td><td>99.2%</td></tr><tr><td>Theirs</td><td>87%</td></tr></table>${note}</figure>`;
const LISTING = `| Page | Figure |\n|---|---|\n| / | Ours: 99.2% bots stopped |\n| / | Theirs: 87% |\n`;

/** The template repo root (MOCK_FIGURES.md) copied, so one test can change it. */
function repoDir(listing: string | null): string {
  const d = tmp("gh-mock-");
  cpSync(TEMPLATE, d, { recursive: true, filter: (p) => !/[\\/](dist|node_modules)$/.test(p) });
  if (listing === null) rmSync(join(d, MOCK_FILE));
  else writeFileSync(join(d, MOCK_FILE), listing);
  return d;
}

test("mock-figures: MOCK_FIGURES.md parsing and number matching", () => {
  assert.deepEqual(numbersIn("1,200 per second, p99 4.5 ms"), ["1200", "99", "4.5"]);
  const l = parseMockFigures(`# Mock\n\n| Page | Figure | Note |\n|---|---|---|\n| /bench, /docs/x/ | 1,200 rps | a |\n| \`/\` | 99.2% | b |\n`);
  assert.equal(l.rows, 2);
  assert.deepEqual([...l.byPage.keys()].sort(), ["/", "/bench/", "/docs/x/"]);
  assert.deepEqual(l.problems, []);
  assert.match(parseMockFigures("no table here").problems[0], /no table/);
  assert.ok(isListedMock("Ours stops 99.2% of bots.", "/", true, parseMockFigures(LISTING)));
  assert.ok(!isListedMock("Ours stops 99.2% of bots.", "/", false, parseMockFigures(LISTING)), "no note on the page");
  assert.ok(!isListedMock("Ours stops 99.3% of bots.", "/", true, parseMockFigures(LISTING)), "number not listed");
  const on = mockOnPage(`<main><section><h2>Speed</h2><p>Reads in <span data-mock>4 ms</span>.</p><p class="note">${SAMPLE_NOTE}</p></section><section><p data-mock>12x faster</p></section></main>`, "/");
  assert.deepEqual(on.figures.map((f) => [f.numbers, f.note_beside]), [[["4"], true], [["12"], false]]);
});

test("mock-figures gate: the template passes (its comparison benchmark is marked, noted and listed)", async () => {
  const t = await serveSite();
  try {
    const g = mockFiguresGate(t.site, TEMPLATE);
    assert.equal(g.status, "pass", JSON.stringify(g.details));
    assert.equal(g.metrics?.pages_with_mock, 1);
    assert.equal(g.metrics?.mock_numbers, 6);
  } finally {
    await t.close();
  }
  assert.equal(mockFiguresGate(null, null).status, "fail");
});

test("mock-figures gate: fails without the note beside the figures, without MOCK_FIGURES.md, on an unlisted number, and on a note with nothing marked", async () => {
  const cases: [string, (d: string) => void, string | null, RegExp][] = [
    ["no note", (d) => edit(page(d, ""), (s) => s.replace("</main>", `${BENCH("")}</main>`)), LISTING, /no "Sample figures for the private preview" note beside/],
    ["note elsewhere on the page", (d) => edit(page(d, ""), (s) => s.replace("</main>", `<section>${BENCH("")}</section><section><p>${SAMPLE_NOTE}</p></section></main>`)), LISTING, /note beside/],
    ["no MOCK_FIGURES.md", (d) => edit(page(d, ""), (s) => s.replace("</main>", `${BENCH()}</main>`)), null, /MOCK_FIGURES\.md is missing/],
    ["unlisted number", (d) => edit(page(d, ""), (s) => s.replace("</main>", `${BENCH().replace("87%", "88%")}</main>`)), LISTING, /does not list 88/],
    ["note without data-mock", (d) => edit(page(d, ""), (s) => s.replace("</main>", `<p>Stops 99.2% of bots.</p><p>${SAMPLE_NOTE}</p></main>`)), LISTING, /no figure is marked data-mock/],
  ];
  for (const [name, mutate, listing, re] of cases) {
    const s = await serveSite((d) => {
      mutate(d);
      // The template's own comparison stays valid: keep its rows in every listing.
    });
    try {
      const dir = repoDir(listing === null ? null : `${listing}| /docs/comparison/ | 1,200 4 310 18 45 120 |\n`);
      const g = mockFiguresGate(s.site, dir);
      assert.equal(g.status, "fail", name);
      assert.match(g.summary, re, `${name}: ${g.summary}`);
    } finally {
      await s.close();
    }
  }
  // Marked, noted beside and listed: passes. A stale listing row only warns.
  const ok = await serveSite((d) => edit(page(d, ""), (s) => s.replace("</main>", `${BENCH()}</main>`)));
  try {
    const listing = `${LISTING}| /docs/comparison/ | 1,200 4 310 18 45 120 |\n`;
    assert.equal(mockFiguresGate(ok.site, repoDir(listing)).status, "pass");
    const stale = mockFiguresGate(ok.site, repoDir(`${listing}| /gone/ | 5 |\n`));
    assert.equal(stale.status, "warn", stale.summary);
  } finally {
    await ok.close();
  }
});

test("claim-sweep: a listed sample figure on a page with the note is covered by MOCK_FIGURES.md, not an outside claim", async () => {
  const s = await serveSite((d) => edit(page(d, ""), (x) => x.replace("</main>", `<section><p data-mock>Cloudflare Bot Management stops 87% of the bots in our benchmark.</p><p>${SAMPLE_NOTE}</p></section></main>`)));
  try {
    const listing = parseMockFigures(LISTING);
    const withMock = sweepCandidates(s.site, [], listing).find((c) => c.sentence.includes("87%"));
    assert.equal(withMock?.covered_by, MOCK_FILE);
    const without = sweepCandidates(s.site, []).find((c) => c.sentence.includes("87%"));
    assert.equal(without?.covered_by, null);
  } finally {
    await s.close();
  }
});

// --- same-ctas and menu-footer-parity --------------------------------------------------------

test("same-ctas: the template passes; a page without the pair, a different second CTA or a different target fails", async () => {
  assert.equal(ctaLabel("  Get a demo → "), "get a demo");
  const t = await serveSite();
  try {
    const g = sameCtasGate(t.site);
    assert.equal(g.status, "pass", g.summary);
    assert.match(g.summary, /"Get a demo" \(\/signup\/\) and "quickstart" \(\/docs\/getting-started\/\)/);
  } finally {
    await t.close();
  }
  const cases: [string, (d: string) => void, RegExp][] = [
    ["missing on one page", (d) => edit(page(d, "pricing"), (s) => s.replace(/<p class="ctas">[\s\S]*?<\/p>/, "").replace(/<li><a href="\/signup\/">Get a demo<\/a><\/li>/, "")), /no "Get a demo" on 1 page\(s\): \/pricing\//],
    ["a different second CTA", (d) => edit(page(d, "pricing"), (s) => s.replaceAll(">Quickstart<", '><button type="button">Copy agent prompt</button><').replaceAll('<a href="/docs/getting-started/"><button', "<span><button").replaceAll("</button></a>", "</button></span>")), /second call to action differs/],
    ["a different target", (d) => edit(page(d, "pricing"), (s) => s.replaceAll('<a href="/signup/">Get a demo</a>', '<a href="/contact/">Get a demo</a>')), /"Get a demo" goes to different places/],
  ];
  for (const [name, mutate, re] of cases) {
    const s = await serveSite(mutate);
    try {
      const g = sameCtasGate(s.site);
      assert.equal(g.status, "fail", name);
      assert.match(g.summary, re, `${name}: ${g.summary}`);
    } finally {
      await s.close();
    }
  }
  assert.equal(sameCtasGate(null).status, "fail");
});

test("menu-footer-parity: the template passes; a footer missing a menu page, or no footer, fails", async () => {
  const t = await serveSite();
  try {
    const g = menuFooterGate(t.site);
    assert.equal(g.status, "pass", g.summary);
  } finally {
    await t.close();
  }
  const missing = await serveSite((d) => edit(page(d, "pricing"), (s) => s.replace('          <li><a href="/pricing/">Pricing</a></li>\n          <li><a href="/signup/">Sign up</a></li>\n          <li><a href="/signup/">Get a demo', '          <li><a href="/signup/">Sign up</a></li>\n          <li><a href="/signup/">Get a demo')));
  try {
    const g = menuFooterGate(missing.site);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /\/pricing\/ the footer misses 1 menu link\(s\) \(pricing \(\/pricing\/\)\)/);
  } finally {
    await missing.close();
  }
  const none = await serveSite((d) => edit(page(d, "docs"), (s) => s.replace(/<footer>[\s\S]*<\/footer>/, "")));
  try {
    const g = menuFooterGate(none.site);
    assert.equal(g.status, "fail");
    assert.match(g.summary, /\/docs\/ no <footer>/);
  } finally {
    await none.close();
  }
  assert.equal(menuFooterGate(null).status, "fail");
});
