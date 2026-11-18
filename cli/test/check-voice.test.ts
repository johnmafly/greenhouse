// product-voice gate (decision 0005): the site reads as a shipping product.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOICE_LIST, VOICE_PATTERNS, jsStrings, pageVoiceSources, productVoiceGate, voiceHits } from "../src/check/voice.ts";
import { edit, serveSite } from "./check-helpers.ts";

const page = (dir: string, route: string) => join(dir, route, "index.html");
type Hit = { source: string; where: string; pattern: string; match: string; snippet: string };
const hitsOf = (g: { details?: unknown }) => ((g.details as { hits?: Hit[] })?.hits ?? []).map((h) => `${h.source} ${h.where} ${h.pattern}`).sort();

test("product-voice: every banned phrase matches, case-insensitive; near misses do not", () => {
  const banned = [
    "Rate limits are fixed by design.",
    "The API is in design.",
    "Webhooks are planned.",
    "We plan to add SSO.",
    "The proposal covers three tiers.",
    "Under the proposed pricing",
    "It proposes a policy file.",
    "A hypothetical customer",
    "BotRampart is a concept.",
    "Book a DEMO",
    "See the mockup",
    "the mock-up below",
    "This prototype runs locally.",
    "Our roadmap",
    "Coming soon",
    "The dashboard is not built.",
    "It is not yet built.",
    "This is not for sale.",
    "Nothing is for sale.",
    "not for sale yet",
    "Illustrative numbers",
    "This is not a real product.",
    "In the first build",
    "Exports come later.",
    "SAML ships later.",
    "See the architecture plan.",
    "placeholder copy here",
  ];
  for (const s of banned) assert.ok(VOICE_PATTERNS.some(([, re]) => re.test(s)), s);
  const fine = [
    "Core concepts",
    "Concepts: policy and cohort",
    "Our value proposition is simple.",
    "We demonstrate it below.",
    "Designed for platform teams.",
    "The Team plan includes SSO.",
    "Upgrade your plan any time.",
    "A mock signup that ends on a first-value screen",
    "Plans and pricing",
    "Built for infra engineers.",
  ];
  for (const s of fine) assert.ok(!VOICE_PATTERNS.some(([, re]) => re.test(s)), s);
});

// The inflected hedge forms VC Joe listed explicitly: each one is on the list and fails on its own.
const INFLECTED = ["proposal", "proposals", "proposed", "propose", "demos", "mockup", "mock-up", "mockups", "prototypes", "plans to", "planning to"];

test("product-voice: every listed inflected form is an explicit form and matches by itself", () => {
  const forms = VOICE_LIST.flatMap(([, f]) => f);
  for (const f of INFLECTED) {
    assert.ok(forms.includes(f), `${f} is listed`);
    const hits = voiceHits([{ source: "/", where: "text", text: `Read the ${f.toUpperCase()} here.` }]);
    assert.deepEqual(hits.map((h) => h.match), [f], f);
  }
  for (const s of ["Concepts", "value proposition", "demonstrate", "demonstration", "planner", "plant"])
    assert.deepEqual(voiceHits([{ source: "/", where: "text", text: s }]), [], s);
});

test("jsStrings: string and template literals; comments and regex literals skipped", () => {
  const js = `// planned: comment only
/* roadmap in a block comment */
const a = "Ships today", b = 'it\\'s live';
const re = /["']planned/g; const c = \`multi
line demo\`;
const d = x / 2; const e = "after division";`;
  const s = jsStrings(js);
  assert.deepEqual(s, ["Ships today", "it's live", "multi line demo", "after division"]);
});

test("pageVoiceSources: title, text, attributes, meta, JSON-LD, inline JS; not HTML comments", () => {
  const html = `<html><head><title>Plans</title><meta name="description" content="Desc">
<meta property="og:title" content="OG"><script type="application/ld+json">{"name":"LD"}</script>
<script>const msg = "inline";</script></head><body><!-- planned comment --><img src="a.png" alt="Alt">
<a href="/" title="Tip" aria-label="Label">Body text</a></body></html>`;
  const where = pageVoiceSources(html, "/").map((s) => `${s.where}=${s.text}`);
  for (const w of ["title=Plans", "meta[description]=Desc", "meta[og:title]=OG", 'json-ld={"name":"LD"}', "inline js string=inline", "img[alt]=Alt", "a[title]=Tip", "a[aria-label]=Label"])
    assert.ok(where.includes(w), w);
  assert.ok(where.some((w) => w.startsWith("text=") && w.includes("Body text")));
  assert.ok(!where.some((w) => w.includes("planned comment")));
  assert.deepEqual(voiceHits(pageVoiceSources(html, "/")), []);
});

test("product-voice gate: passes on the template; comments, Concepts and value proposition do not fail", async () => {
  const ok = await serveSite();
  try {
    const g = await productVoiceGate(ok.site);
    assert.equal(g.status, "pass", JSON.stringify(g));
  } finally {
    await ok.close();
  }
  const near = await serveSite((d) => {
    edit(page(d, "docs"), (s) => s.replace("</main>", "<!-- planned: by design --><h2>Concepts</h2><p>The value proposition, demonstrated.</p></main>"));
  });
  try {
    assert.equal((await productVoiceGate(near.site)).status, "pass");
  } finally {
    await near.close();
  }
  assert.equal((await productVoiceGate(null, "build failed")).status, "fail");
});

test("product-voice gate: a Concepts heading passes", async () => {
  const ok = await serveSite((d) => edit(page(d, "docs"), (s) => s.replace("</main>", '<h2 id="concepts">Concepts</h2><p>Policy, cohort and verdict.</p></main>')));
  try {
    const g = await productVoiceGate(ok.site);
    assert.equal(g.status, "pass", JSON.stringify(g));
  } finally {
    await ok.close();
  }
});

for (const form of INFLECTED) {
  test(`product-voice gate: fails on "${form}" in visible text`, async () => {
    const bad = await serveSite((d) => edit(page(d, "pricing"), (s) => s.replace("</main>", `<p>Team pricing: see the ${form} below.</p></main>`)));
    try {
      const g = await productVoiceGate(bad.site);
      assert.equal(g.status, "fail", form);
      const hits = (g.details as { hits: Hit[] }).hits;
      assert.deepEqual(hits.map((h) => `${h.source} ${h.where} ${h.match}`), [`/pricing/ text ${form}`]);
      assert.ok(g.summary.includes(form), g.summary);
    } finally {
      await bad.close();
    }
  });
}

test("product-voice gate: fails on visible text and on the 404 page", async () => {
  const bad = await serveSite((d) => {
    edit(page(d, "pricing"), (s) => s.replace("</main>", "<p>Paid tiers are planned; nothing is for sale yet.</p></main>"));
    edit(join(d, "404.html"), (s) => s.replace("</main>", "<p>This page is part of the proposal.</p></main>"));
  });
  try {
    const g = await productVoiceGate(bad.site);
    assert.equal(g.status, "fail");
    assert.deepEqual(hitsOf(g), ["/pricing/ text for sale yet", "/pricing/ text nothing is for sale", "/pricing/ text planned", "404 page text propos*"]);
    const h = (g.details as { hits: Hit[] }).hits.find((x) => x.pattern === "planned");
    assert.match(h?.snippet ?? "", /Paid tiers are planned/);
  } finally {
    await bad.close();
  }
});

test("product-voice gate: fails on a hit only in alt text", async () => {
  const bad = await serveSite((d) => edit(page(d, ""), (s) => s.replace("</main>", '<img src="/hero.png" alt="Dashboard mockup"></main>')));
  try {
    const g = await productVoiceGate(bad.site);
    assert.equal(g.status, "fail");
    assert.deepEqual(hitsOf(g), ["/ img[alt] mockup"]);
  } finally {
    await bad.close();
  }
});

test("product-voice gate: fails on a hit only in meta (description and og)", async () => {
  const bad = await serveSite((d) =>
    edit(page(d, "docs"), (s) => s.replace("</head>", '<meta property="og:description" content="A concept for bot defence."></head>').replace(/(<meta name="description" content=")[^"]*/, "$1The roadmap for Example Seed")),
  );
  try {
    const g = await productVoiceGate(bad.site);
    assert.equal(g.status, "fail");
    assert.deepEqual(hitsOf(g), ["/docs/ meta[description] roadmap", "/docs/ meta[og:description] concept"]);
  } finally {
    await bad.close();
  }
});

test("product-voice gate: fails on a hit only in served JS (external script and its import)", async () => {
  const bad = await serveSite((d) => {
    writeFileSync(join(d, "app.js"), `import "./banner.js";\n// a comment that says planned is fine\nexport const label = "Live";`);
    writeFileSync(join(d, "banner.js"), `document.body.dataset.note = "Exports ship later.";`);
    edit(page(d, ""), (s) => s.replace("</body>", '<script type="module" src="/app.js"></script></body>'));
  });
  try {
    const g = await productVoiceGate(bad.site);
    assert.equal(g.status, "fail");
    assert.deepEqual(hitsOf(g), ["/banner.js js string ships later"]);
    assert.equal((g.metrics as { scripts: number }).scripts, 2);
  } finally {
    await bad.close();
  }
});

test("product-voice gate: fails on JSON-LD, aria-label, inline JS, llms.txt and a linked yaml file", async () => {
  const bad = await serveSite((d) => {
    edit(page(d, ""), (s) =>
      s
        .replace("</head>", '<script type="application/ld+json">{"@type":"SoftwareApplication","description":"A hypothetical bot firewall"}</script></head>')
        .replace("</main>", '<button aria-label="Open the demo">Open</button><script>const t = "Illustrative pricing";</script><a href="/spec/policy.yaml">Policy</a></main>'),
    );
    writeFileSync(join(d, "llms.txt"), "# Example Seed\n\nExample Seed is not a real product.\n");
    mkdirSync(join(d, "spec"), { recursive: true });
    writeFileSync(join(d, "spec", "policy.yaml"), "description: Cohorts are planned for v2\n");
  });
  try {
    const g = await productVoiceGate(bad.site);
    assert.equal(g.status, "fail");
    assert.deepEqual(hitsOf(g), [
      "/ button[aria-label] demo",
      "/ inline js string illustrative",
      "/ json-ld hypothetical",
      "/llms.txt file not a real",
      "/spec/policy.yaml file planned",
    ]);
  } finally {
    await bad.close();
  }
});

