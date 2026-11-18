// docs gate (decision 0006): every project ships a comprehensive user guide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_KEYS, docsContent, docsGate, headingsWithoutIds, markdownCandidates, parseDocsMap, wordCount } from "../src/check/docs.ts";
import { serveStatic } from "../src/check/serve.ts";
import { crawl } from "../src/check/site.ts";
import { TEMPLATE, builtSite, edit, tmp } from "./check-helpers.ts";

const page = (dir: string, route: string) => join(dir, route, "index.html");
type G = Awaited<ReturnType<typeof docsGate>>;
const problems = (g: G) => ((g.details as { problems?: string[] })?.problems ?? []).join("\n");

/** The template's repo files (greenhouse.yaml, spec/) and its built site, each optionally mutated, then the gate. */
async function run(opts: { repo?: (dir: string) => void; site?: (dir: string) => void } = {}): Promise<G> {
  const repo = tmp("gh-docs-repo-");
  cpSync(TEMPLATE, repo, { recursive: true, filter: (p) => !/[\\/](dist|node_modules)$/.test(p) });
  opts.repo?.(repo);
  const dist = builtSite(opts.site);
  const server = await serveStatic(dist);
  try {
    const site = await crawl(server.url);
    return await docsGate(site, repo);
  } finally {
    await server.close();
  }
}

const yamlEdit = (fn: (s: string) => string) => (dir: string) => edit(join(dir, "greenhouse.yaml"), fn);

test("docs map: thirteen required keys, paths or lists of paths, anchors allowed", () => {
  assert.equal(DOCS_KEYS.length, 13);
  const all = Object.fromEntries(DOCS_KEYS.map((k) => [k, `/docs/${k}/`]));
  assert.deepEqual(parseDocsMap({ docs: all }).errors, []);
  const list = parseDocsMap({ docs: { ...all, domain_reference: ["/docs/policy/", "/docs/cohorts/#rules"] } });
  assert.deepEqual(list.errors, []);
  assert.deepEqual(list.sections.get("domain_reference")?.map((r) => [r.path, r.anchor]), [["/docs/policy/", null], ["/docs/cohorts/", "rules"]]);
  const { faq: _faq, ...noFaq } = all;
  const bad = parseDocsMap({ docs: { ...noFaq, extra: "/x/", security: "https://evil.example/" } });
  assert.ok(bad.errors.some((e) => /docs\.faq is missing/.test(e)), bad.errors.join());
  assert.ok(bad.errors.some((e) => /docs\.extra is not a known section/.test(e)), bad.errors.join());
  assert.ok(bad.errors.some((e) => /docs\.security/.test(e) && /not a site path/.test(e)), bad.errors.join());
  assert.equal(parseDocsMap({}).present, false);
});

test("docs helpers: Markdown candidates, guide content without nav, heading ids, word count", () => {
  assert.deepEqual(markdownCandidates("/docs/api/"), ["/docs/api/index.md", "/docs/api.md"]);
  assert.deepEqual(markdownCandidates("/docs/api.html"), ["/docs/api.md"]);
  const html = `<body><nav>Home Docs Pricing</nav><main><aside>Sidebar words</aside><h1>T</h1><h2 id="a">A</h2><h2>B</h2><h3><a id="c" href="#c">C</a></h3><p>one two three</p></main></body>`;
  assert.equal(wordCount("one two-three it's 4.2"), 4);
  assert.ok(!/Sidebar|Pricing/.test(docsContent(html)));
  assert.deepEqual(headingsWithoutIds(html), ["h2 B"]);
});

test("docs gate: the template's guide passes (13 sections, Markdown, llms files, every API operation)", async () => {
  const g = await run();
  assert.equal(g.status, "pass", JSON.stringify(g, null, 1));
  assert.equal(g.metrics?.sections, 13);
  assert.equal(g.metrics?.markdown, 13);
  assert.equal(g.metrics?.operations, 2);
  assert.equal(g.metrics?.operations_missing, 0);
});

test("docs gate: no docs block fails", async () => {
  const g = await run({ repo: yamlEdit((s) => s.replace(/\n# Where each section of the user guide lives[\s\S]*$/, "\n")) });
  assert.equal(g.status, "fail");
  assert.match(g.summary, /no docs: block/);
});

test("docs gate: a missing or unknown section key fails", async () => {
  const g = await run({ repo: yamlEdit((s) => s.replace(/^  sdk_reference: .*\n/m, "  sdk: /docs/sdk/\n")) });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /docs\.sdk_reference is missing/);
  assert.match(problems(g), /docs\.sdk is not a known section/);
});

test("docs gate: a section whose page is gone fails", async () => {
  const g = await run({ site: (d) => rmSync(join(d, "docs", "security"), { recursive: true }) });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /docs\.security: \/docs\/security\/ returns 404/);
});

test("docs gate: a thin section under its word floor fails", async () => {
  const g = await run({ site: (d) => edit(page(d, "docs/configuration"), (s) => s.replace(/<main>[\s\S]*<\/main>/, '<main><h1>Configuration</h1><p>Set SEED_API_KEY.</p></main>')) });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /docs\.configuration \(Configuration\): \d+ words, under the 150-word floor/);
});

test("docs gate: an anchor that is not on the page fails; an anchor that is passes", async () => {
  const bad = await run({ repo: yamlEdit((s) => s.replace("faq: /docs/faq/", "faq: /docs/faq/#questions")) });
  assert.equal(bad.status, "fail");
  assert.match(problems(bad), /docs\.faq: \/docs\/faq\/#questions has no element with id "questions"/);
  const ok = await run({
    repo: yamlEdit((s) => s.replace("faq: /docs/faq/", "faq: /docs/faq/#questions")),
    site: (d) => edit(page(d, "docs/faq"), (s) => s.replace("<main>", '<main id="questions">')),
  });
  assert.equal(ok.status, "pass", problems(ok));
});

test("docs gate: an architecture section without a diagram fails", async () => {
  const g = await run({ site: (d) => edit(page(d, "docs/architecture"), (s) => s.replace(/<figure>[\s\S]*<\/figure>/, "")) });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /docs\.architecture: no diagram/);
});

test("docs gate: an API reference missing an operation from spec/openapi.yaml fails", async () => {
  const g = await run({
    repo: (d) =>
      edit(join(d, "spec", "openapi.yaml"), (s) =>
        s.replace("paths:\n", 'paths:\n  /v1/projects/{name}/archive:\n    post:\n      operationId: archiveProject\n      summary: Archive\n      responses:\n        "200":\n          description: Archived\n'),
      ),
  });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /docs\.api_reference: 1 of 3 operations .* not documented: POST \/v1\/projects\/\{name\}\/archive \(archiveProject\)/);
});

test("docs gate: without an OpenAPI spec the operation check does not apply", async () => {
  const g = await run({
    repo: (d) => {
      rmSync(join(d, "spec", "openapi.yaml"));
      writeFileSync(join(d, "spec", "interface.md"), "# Interface\n\noperationId: createProject\n");
    },
  });
  assert.equal(g.status, "pass", problems(g));
  assert.equal(g.metrics?.operations, 0);
});

test("docs gate: a docs page with no Markdown version fails", async () => {
  const g = await run({ site: (d) => rmSync(join(d, "docs", "faq.md")) });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /\/docs\/faq\/: no Markdown version/);
});

test("docs gate: an HTML page served at the .md URL is not a Markdown version", async () => {
  const g = await run({ site: (d) => cpSync(page(d, "docs/faq"), join(d, "docs", "faq.md")) });
  assert.equal(g.status, "fail");
  assert.match(problems(g), /\/docs\/faq\/: no Markdown version/);
});

test("docs gate: /llms.txt missing, or not listing a docs page, fails", async () => {
  const gone = await run({ site: (d) => rmSync(join(d, "llms.txt")) });
  assert.equal(gone.status, "fail");
  assert.match(problems(gone), /\/llms\.txt is missing/);
  const partial = await run({ site: (d) => edit(join(d, "llms.txt"), (s) => s.replace(/^- \[SDK reference\].*\n/m, "")) });
  assert.equal(partial.status, "fail");
  assert.match(problems(partial), /\/llms\.txt does not list 1 docs page: \/docs\/sdk\//);
});

test("docs gate: /llms-full.txt missing, or without a docs page, fails", async () => {
  const gone = await run({ site: (d) => rmSync(join(d, "llms-full.txt")) });
  assert.equal(gone.status, "fail");
  assert.match(problems(gone), /\/llms-full\.txt is missing/);
  const partial = await run({
    site: (d) => edit(join(d, "llms-full.txt"), (s) => s.split("\n---\n").filter((part) => !part.includes("/docs/changelog")).join("\n---\n")),
  });
  assert.equal(partial.status, "fail");
  assert.match(problems(partial), /\/llms-full\.txt does not list 1 docs page: \/docs\/changelog\//);
});

test("docs gate: headings without ids (no stable anchors) warn", async () => {
  const g = await run({ site: (d) => edit(page(d, "docs/faq"), (s) => s.replace('<h2 id="do-i-need-the-sdk">', "<h2>")) });
  assert.equal(g.status, "warn", JSON.stringify(g.details));
  assert.match(JSON.stringify(g.details), /\/docs\/faq\/: 1 heading without an id/);
});
