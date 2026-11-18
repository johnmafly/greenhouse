import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown.ts";

test("renders the constructs rulings use", () => {
  const html = renderMarkdown(
    "## Ruling: revise\n\nScore **8.95**, see `checks.json` and [rubric](/judge/).\n\n- one\n- two *now*\n\n1. first\n2. second\n\n> quoted\n\n```\nnpm test\n```\n\n---\n",
    { headingOffset: 2 },
  );
  assert.match(html, /<h4>Ruling: revise<\/h4>/);
  assert.match(html, /<p>Score <strong>8\.95<\/strong>, see <code>checks\.json<\/code> and <a href="\/judge\/" rel="noopener noreferrer">rubric<\/a>\.<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two <em>now<\/em><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
  assert.match(html, /<hr>/);
});

test("escapes HTML and refuses script URLs", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> "q"');
  assert.doesNotMatch(html, /<script|<img|href="javascript/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;q&quot;/);
});

test("does not format inside code spans or snake_case words", () => {
  const html = renderMarkdown("Use `**not bold**` for dimension_medians and site_craft.");
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
  assert.match(html, /dimension_medians and site_craft/);
});
