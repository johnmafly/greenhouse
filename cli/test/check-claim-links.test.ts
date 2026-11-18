// claim-links gate: one fixture per status class, the refused-automation rules, and the 20% cap.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_USER_AGENT, classifyStatus, claimLinksGate, probeUrl, readClaimUrls } from "../src/check/claim-links.ts";
import { validate } from "../src/lib/schemas.ts";
import { TEMPLATE, tmp } from "./check-helpers.ts";

let server: Server;
let base = "";
const seen: { method: string; path: string; ua: string }[] = [];
let rateOnceHits = 0;

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ method: req.method ?? "", path, ua: String(req.headers["user-agent"] ?? "") });
    const send = (status: number, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html", ...headers });
      res.end(req.method === "HEAD" ? undefined : "<p>x</p>");
    };
    switch (path) {
      case "/ok":
        return send(200);
      case "/redir":
        return send(301, { location: "/ok" });
      case "/head405":
        return req.method === "HEAD" ? send(405) : send(200);
      case "/unauth":
        return send(401);
      case "/forbidden":
        return send(403);
      case "/rate":
        return send(429);
      case "/rate-once":
        if (req.method === "HEAD") return send(429);
        return send(rateOnceHits++ === 0 ? 429 : 200);
      case "/gone":
        return send(410);
      case "/missing":
        return send(404);
      case "/err":
        return send(503);
      case "/slow":
        return; // never answers
      default:
        return send(404);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const FAST = { timeoutMs: 400, retryDelayMs: 20 };
const NOW = new Date("2026-11-18T12:00:00Z");

function project(claims: { id: string; url: string; quote?: string; checked?: string }[]): string {
  const dir = tmp("gh-claim-links-");
  const yaml = ["claims:"]
    .concat(
      claims.flatMap((c) => [
        `  - id: ${c.id}`,
        `    claim: "c"`,
        `    where: /`,
        `    source_url: ${c.url}`,
        ...(c.quote === undefined ? [] : [`    quote: ${JSON.stringify(c.quote)}`]),
        ...(c.checked === undefined ? [] : [`    checked: ${c.checked}`]),
      ]),
    )
    .join("\n");
  writeFileSync(join(dir, "claims.yaml"), claims.length ? yaml + "\n" : "claims: []\n");
  return dir;
}

test("claim-links: status classes 2xx/3xx ok, 401/403/429 refused, 404/410/5xx/errors broken", () => {
  for (const s of [200, 204, 301, 304]) assert.equal(classifyStatus(s), "ok", String(s));
  for (const s of [401, 403, 429]) assert.equal(classifyStatus(s), "refused", String(s));
  for (const s of [400, 404, 405, 410, 500, 503, "dns", "timeout", "network: ECONNREFUSED"]) assert.equal(classifyStatus(s), "broken", String(s));
});

test("claim-links probe: browser UA, HEAD then GET, redirects followed, 429 retried once, timeout and DNS errors", async () => {
  seen.length = 0;
  assert.deepEqual(await probeUrl(`${base}/ok`, FAST), { status: 200, method: "HEAD" });
  assert.equal(seen[0].ua, BROWSER_USER_AGENT);
  assert.equal((await probeUrl(`${base}/redir`, FAST)).status, 200);
  assert.deepEqual(await probeUrl(`${base}/head405`, FAST), { status: 200, method: "GET" });
  assert.equal((await probeUrl(`${base}/forbidden`, FAST)).status, 403);
  assert.equal((await probeUrl(`${base}/unauth`, FAST)).status, 401);
  assert.deepEqual(await probeUrl(`${base}/rate`, FAST), { status: 429, method: "GET", note: "429 retried once" });
  assert.equal(seen.filter((s) => s.path === "/rate").map((s) => s.method).join(","), "HEAD,GET,GET");
  rateOnceHits = 0;
  assert.deepEqual(await probeUrl(`${base}/rate-once`, FAST), { status: 200, method: "GET", note: "429 retried once" });
  assert.equal((await probeUrl(`${base}/gone`, FAST)).status, 410);
  assert.equal((await probeUrl(`${base}/missing`, FAST)).status, 404);
  assert.equal((await probeUrl(`${base}/err`, FAST)).status, 503);
  assert.equal((await probeUrl(`${base}/slow`, FAST)).status, "timeout");
  assert.equal((await probeUrl("http://greenhouse-claim-links-test.invalid/", FAST)).status, "dns");
  assert.match(String((await probeUrl("http://127.0.0.1:9/", FAST)).status), /^network: /);
});

test("claim-links gate: no claims passes; missing or unparseable claims.yaml fails; no checkout fails", async () => {
  const g = await claimLinksGate(TEMPLATE, { ...FAST, now: NOW });
  assert.equal(g.status, "pass");
  assert.equal(g.metrics?.urls, 0);
  assert.equal((await claimLinksGate(tmp(), FAST)).status, "fail");
  const bad = tmp();
  writeFileSync(join(bad, "claims.yaml"), "claims: [\n");
  assert.match((await claimLinksGate(bad, FAST)).summary, /cannot run: claims.yaml does not parse/);
  assert.match((await claimLinksGate(null, FAST)).summary, /cannot run/);
});

test("claim-links gate: all resolving passes and records each URL's status and class", async () => {
  const dir = project([
    { id: "a", url: `${base}/ok`, quote: "q", checked: "2026-11-01" },
    { id: "b", url: `${base}/redir`, quote: "q", checked: "2026-11-01" },
    { id: "c", url: `${base}/head405`, quote: "q", checked: "2026-11-01" },
    { id: "d", url: `${base}/ok`, quote: "q", checked: "2026-11-01" },
  ]);
  const g = await claimLinksGate(dir, { ...FAST, now: NOW });
  assert.equal(g.status, "pass", g.summary);
  assert.equal(g.metrics?.urls, 3);
  const urls = (g.details as { urls: { url: string; status: number; class: string; claims: string[] }[] }).urls;
  assert.deepEqual(urls.find((u) => u.url.endsWith("/ok"))?.claims, ["a", "d"]);
  assert.ok(urls.every((u) => u.class === "ok" && u.status === 200));
});

test("claim-links gate: refused URLs warn only with a quote and `checked` within 30 days", async () => {
  const ok = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ok${i}`, url: `${base}/ok?${i}`, quote: "q", checked: "2026-11-01" }));
  // 1 refused of 5 = 20%: not over the cap, quoted and checked 30 days ago -> warn.
  let g = await claimLinksGate(project([...ok(4), { id: "r", url: `${base}/forbidden`, quote: "verbatim", checked: "2026-10-19" }]), { ...FAST, now: NOW });
  assert.equal(g.status, "warn", g.summary);
  assert.equal(g.metrics?.refused, 1);
  const r = (g.details as { urls: { url: string; class: string; status: number; accepted: boolean }[] }).urls.find((u) => u.url.endsWith("/forbidden"));
  assert.deepEqual([r?.class, r?.status, r?.accepted], ["refused", 403, true]);
  // checked 31 days before the run -> fail
  g = await claimLinksGate(project([...ok(4), { id: "r", url: `${base}/forbidden`, quote: "verbatim", checked: "2026-10-18" }]), { ...FAST, now: NOW });
  assert.equal(g.status, "fail", g.summary);
  assert.match(g.summary, /refused automation without a quote/);
  // empty quote -> fail
  g = await claimLinksGate(project([...ok(4), { id: "r", url: `${base}/unauth`, quote: " ", checked: "2026-11-17" }]), { ...FAST, now: NOW });
  assert.equal(g.status, "fail", g.summary);
  // no checked date -> fail
  g = await claimLinksGate(project([...ok(4), { id: "r", url: `${base}/rate`, quote: "q" }]), { ...FAST, now: NOW });
  assert.equal(g.status, "fail", g.summary);
  // one of two claims citing the refused URL lacks a quote -> fail
  g = await claimLinksGate(
    project([...ok(4), { id: "r1", url: `${base}/forbidden`, quote: "q", checked: "2026-11-17" }, { id: "r2", url: `${base}/forbidden`, checked: "2026-11-17" }]),
    { ...FAST, now: NOW },
  );
  assert.equal(g.status, "fail", g.summary);
});

test("claim-links gate: more than 20% refused fails even when every refused claim is quoted and fresh", async () => {
  const fresh = { quote: "q", checked: "2026-11-17" };
  const g = await claimLinksGate(
    project([
      { id: "a", url: `${base}/ok?1`, ...fresh },
      { id: "b", url: `${base}/ok?2`, ...fresh },
      { id: "c", url: `${base}/ok?3`, ...fresh },
      { id: "d", url: `${base}/forbidden`, ...fresh },
      { id: "e", url: `${base}/unauth`, ...fresh },
    ]),
    { ...FAST, now: NOW },
  );
  assert.equal(g.status, "fail", g.summary);
  assert.match(g.summary, /2\/5 refused automation \(over 20%\)/);
});

test("claim-links gate: 404, 410, 5xx, timeout and DNS errors fail; the gate fits checks.json", async () => {
  for (const url of [`${base}/missing`, `${base}/gone`, `${base}/err`, `${base}/slow`, "http://greenhouse-claim-links-test.invalid/x"]) {
    const g = await claimLinksGate(project([{ id: "a", url, quote: "q", checked: "2026-11-17" }]), { ...FAST, now: NOW });
    assert.equal(g.status, "fail", url);
    assert.match(g.summary, /1 broken/, url);
  }
  const g = await claimLinksGate(project([{ id: "a", url: `${base}/missing`, quote: "q", checked: "2026-11-17" }]), { ...FAST, now: NOW });
  const checks = {
    schema_version: 1, slug: "x", round: 1, sha: "0".repeat(40), deployment_url: "http://127.0.0.1/", cli_version: "0", tool_versions: {},
    machine: "m", started_at: NOW.toISOString(), finished_at: NOW.toISOString(), gates: [g], all_green: false,
  };
  const v = validate("checks", JSON.parse(JSON.stringify(checks)));
  assert.ok(v.valid, v.errors.join("; "));
});

test("readClaimUrls reads source_url from a claims.yaml that is not schema-valid", () => {
  const dir = tmp();
  writeFileSync(join(dir, "claims.yaml"), "claims:\n  - id: x\n    source_url: https://example.com/a\n    status: verified\n  - id: y\n    note: no url\n");
  assert.deepEqual(readClaimUrls(dir).refs.map((r) => r.url), ["https://example.com/a"]);
});
