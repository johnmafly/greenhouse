import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildManifest,
  canonicalJson,
  computeBundleHash,
  serializeManifest,
  sha256,
  verifyBundle,
  insideGitCheckout,
} from "../src/capture-manifest.ts";
import { parseR2Target, uploadBundle } from "../src/capture-r2.ts";
import { CONTRACT_ROUTES, capture, parseRoutes, routeName } from "../src/capture.ts";

async function bundleDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gh-bundle-"));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  return dir;
}

describe("manifest hashing", () => {
  test("sha256 of every file, sorted paths, sizes", async () => {
    const dir = await bundleDir({ "b.txt": "bee", "a/x.txt": "ex", "a/y.png": "" });
    const m = await buildManifest(dir, { url: "https://example.test/" });
    assert.deepEqual(m.files.map((f) => f.path), ["a/x.txt", "a/y.png", "b.txt"]);
    assert.equal(m.files[2].sha256, sha256("bee"));
    assert.equal(m.files[1].sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(m.files[0].bytes, 2);
  });

  test("bundle hash is canonical: independent of key order and formatting", async () => {
    const m1 = { url: "u", files: [{ path: "a", sha256: "1", bytes: 1 }], meta: { b: 1, a: 2 } };
    const m2 = { meta: { a: 2, b: 1 }, files: [{ bytes: 1, sha256: "1", path: "a" }], url: "u" };
    assert.equal(computeBundleHash(m1), computeBundleHash(m2));
    assert.equal(canonicalJson({ b: [1, { d: null, c: "x" }], a: true }), '{"a":true,"b":[1,{"c":"x","d":null}]}');
    // bundle_hash itself is excluded from what it hashes
    assert.equal(computeBundleHash({ ...m1, bundle_hash: "zzz" }), computeBundleHash(m1));
  });

  test("bundle hash changes when any file or metadata changes", async () => {
    const dir = await bundleDir({ "a.txt": "one" });
    const base = await buildManifest(dir, { url: "https://example.test/" });
    assert.notEqual((await buildManifest(dir, { url: "https://other.test/" })).bundle_hash, base.bundle_hash);
    await writeFile(join(dir, "a.txt"), "two");
    assert.notEqual((await buildManifest(dir, { url: "https://example.test/" })).bundle_hash, base.bundle_hash);
  });

  test("verifyBundle passes on an intact bundle and names each kind of tampering", async () => {
    const dir = await bundleDir({ "a.txt": "one", "p/b.txt": "two" });
    const m = await buildManifest(dir, { url: "x" });
    await writeFile(join(dir, "manifest.json"), serializeManifest(m));
    assert.deepEqual(await verifyBundle(dir), { ok: true, errors: [], bundle_hash: m.bundle_hash });

    await writeFile(join(dir, "a.txt"), "ONE");
    await writeFile(join(dir, "extra.txt"), "x");
    await rm(join(dir, "p/b.txt"));
    const r = await verifyBundle(dir);
    assert.equal(r.ok, false);
    assert.ok(r.errors.includes("sha256 mismatch: a.txt"));
    assert.ok(r.errors.includes("missing file: p/b.txt"));
    assert.ok(r.errors.includes("file not in manifest: extra.txt"));

    const dir2 = await bundleDir({ "a.txt": "one" });
    const m2 = await buildManifest(dir2, { url: "x" });
    await writeFile(join(dir2, "manifest.json"), serializeManifest({ ...m2, url: "y" }));
    assert.match((await verifyBundle(dir2)).errors.join(), /bundle_hash mismatch/);
  });

  test("bundles must live outside git checkouts (decision 0002)", async () => {
    assert.ok(await insideGitCheckout(process.cwd())); // this repo
    assert.equal(await insideGitCheckout(await mkdtemp(join(tmpdir(), "gh-out-"))), null);
  });
});

describe("routes", () => {
  test("default routes are the package contract's", () => {
    assert.deepEqual(parseRoutes(undefined), CONTRACT_ROUTES);
    assert.equal(CONTRACT_ROUTES.length, 9);
    assert.deepEqual(parseRoutes("/, /pricing/"), ["/", "/pricing/"]);
    assert.throws(() => parseRoutes("pricing"));
  });
  test("route names are ordered and filesystem-safe", () => {
    assert.equal(routeName("/", 0), "01-home");
    assert.equal(routeName("/docs/how-it-works/", 2), "03-docs-how-it-works");
    assert.equal(routeName("/a b/?q=1", 9), "10-a_b");
  });
});

describe("R2 upload", () => {
  test("parses <bucket>/<prefix>", () => {
    assert.deepEqual(parseR2Target("greenhouse-evidence/rounds/demo/01"), { bucket: "greenhouse-evidence", prefix: "rounds/demo/01" });
    assert.deepEqual(parseR2Target("greenhouse-evidence"), { bucket: "greenhouse-evidence", prefix: "" });
    assert.throws(() => parseR2Target("Bad_Bucket/x"));
    assert.throws(() => parseR2Target("bucket/../x"));
  });

  test("uploads content-addressed keys with the env token and never leaks it", async () => {
    const dir = await bundleDir({ "a.txt": "one", "b.png": "png" });
    const m = await buildManifest(dir, { url: "x" });
    await writeFile(join(dir, "manifest.json"), serializeManifest(m));
    const calls: { url: string; method: string; auth: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>).Authorization });
      if (url.endsWith("/accounts")) return Response.json({ success: true, result: [{ id: "acct1" }] });
      return Response.json({ success: true, result: {} });
    }) as typeof fetch;
    const up = await uploadBundle(dir, m, { bucket: "greenhouse-evidence", prefix: "p" }, { env: { CLOUDFLARE_API_TOKEN: "t0k" }, fetchFn: fakeFetch });
    const manifestHash = sha256(await readFile(join(dir, "manifest.json")));
    assert.deepEqual(up.objects.map((o) => o.key), [`p/sha256/${sha256("one")}`, `p/sha256/${sha256("png")}`, `p/sha256/${manifestHash}`, `p/bundles/${m.bundle_hash}.json`]);
    assert.ok(calls.every((c) => c.auth === "Bearer t0k"));
    assert.equal(calls[1].url, `https://api.cloudflare.com/client/v4/accounts/acct1/r2/buckets/greenhouse-evidence/objects/p/sha256/${sha256("one")}`);
    assert.ok(calls.slice(1).every((c) => c.method === "PUT"));
  });

  test("refuses without a token, and when a file changed after the manifest", async () => {
    const dir = await bundleDir({ "a.txt": "one" });
    const m = await buildManifest(dir, { url: "x" });
    await writeFile(join(dir, "manifest.json"), serializeManifest(m));
    await assert.rejects(uploadBundle(dir, m, { bucket: "b-1", prefix: "" }, { env: {} }), /CLOUDFLARE_API_TOKEN is not set/);
    await writeFile(join(dir, "a.txt"), "changed");
    const ok = (async () => Response.json({ success: true, result: {} })) as unknown as typeof fetch;
    await assert.rejects(uploadBundle(dir, m, { bucket: "b-1", prefix: "" }, { env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }, fetchFn: ok }), /changed since the manifest/);
  });

  test("surfaces Cloudflare API errors", async () => {
    const dir = await bundleDir({ "a.txt": "one" });
    const m = await buildManifest(dir, { url: "x" });
    await writeFile(join(dir, "manifest.json"), serializeManifest(m));
    const denied = (async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(uploadBundle(dir, m, { bucket: "b-1", prefix: "" }, { env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }, fetchFn: denied }), /HTTP 403.*Authentication error/);
  });
});

describe("capture CLI arguments", () => {
  test("refuses an --out inside a git checkout", () => {
    const r = spawnSync(process.execPath, ["cli/src/main.ts", "capture", "--url", "http://127.0.0.1:9/", "--out", "cli/test/tmp-bundle"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /outside every git checkout/);
  });
  test("--r2 without a token is a usage error", () => {
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    const r = spawnSync(process.execPath, ["cli/src/main.ts", "capture", "--url", "http://x.test/", "--out", join(tmpdir(), "nope"), "--r2", "greenhouse-evidence/x"], { encoding: "utf8", env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CLOUDFLARE_API_TOKEN/);
  });
});

// ---- Browser test: real Playwright capture of a local fixture site ----

async function chromiumAvailable(): Promise<string | false> {
  if (process.env.GREENHOUSE_SKIP_BROWSER_TESTS) return "GREENHOUSE_SKIP_BROWSER_TESTS is set";
  try {
    const { chromium } = await import("playwright");
    if (!existsSync(chromium.executablePath())) return "Playwright Chromium is not installed (npx playwright install chromium)";
    return false;
  } catch (e) {
    return `playwright unavailable: ${(e as Error).message}`;
  }
}
const browserSkip = await chromiumAvailable();

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)} .tall{height:2400px}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;

test("capture writes a valid bundle for every route [browser]", { skip: browserSkip }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/greenhouse.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ slug: "fixture", sha: "a".repeat(40), built_at: "2026-11-18T00:00:00Z" }));
    }
    if (req.url === "/missing/") {
      res.statusCode = 404;
      return res.end(PAGE("Not found", "<p>nope</p>"));
    }
    res.setHeader("content-type", "text/html");
    res.end(
      PAGE(
        `Page ${req.url}`,
        `<p>Visible paragraph on ${req.url}.</p>
         <p style="display:none">HIDDEN-DISPLAY reviewer instruction</p>
         <p style="visibility:hidden">HIDDEN-VISIBILITY</p>
         <p style="opacity:0">HIDDEN-OPACITY</p>
         <span class="sr">HIDDEN-SRONLY</span>
         <p style="position:absolute;left:-9999px">HIDDEN-OFFSCREEN</p>
         <p style="color:transparent">HIDDEN-TRANSPARENT</p>
         <div class="tall"></div><p>Footer text far below the fold.</p>`,
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), "gh-capture-"));
  const out = join(root, "bundle");
  try {
    const m = await capture({ url: `http://127.0.0.1:${port}/`, out, routes: ["/", "/docs/", "/missing/"], log: () => {} });
    assert.match(m.bundle_hash!, /^[0-9a-f]{64}$/);
    assert.deepEqual((m.deployment as { slug: string }).slug, "fixture");
    const pages = m.pages as { route: string; status: number; files: { desktop: string; mobile: string; text: string } }[];
    assert.deepEqual(pages.map((p) => [p.route, p.status]), [["/", 200], ["/docs/", 200], ["/missing/", 404]]);
    // 3 routes x (desktop, mobile, text) + well-known
    assert.equal(m.files.length, 10);
    const v = await verifyBundle(out);
    assert.deepEqual(v.errors, []);

    // PNG dimensions: desktop 1440 wide full page, mobile 390 CSS px at 2x
    const png = await readFile(join(out, pages[0].files.desktop));
    assert.equal(png.readUInt32BE(16), 1440);
    assert.ok(png.readUInt32BE(20) > 2400, "full-page screenshot is taller than the viewport");
    const mob = await readFile(join(out, pages[0].files.mobile));
    assert.equal(mob.readUInt32BE(16), 780);
    assert.equal((m.pages as { mobile_layout_width: number }[])[0].mobile_layout_width, 390);

    const text = await readFile(join(out, pages[0].files.text), "utf8");
    assert.match(text, /Visible paragraph on \//);
    assert.match(text, /Footer text far below the fold\./);
    assert.doesNotMatch(text, /HIDDEN-/);
    assert.ok((m.pages as { hidden_text_chars: number }[])[0].hidden_text_chars > 0);

    // The CLI refuses to overwrite an existing bundle.
    await assert.rejects(capture({ url: `http://127.0.0.1:${port}/`, out, routes: ["/"], log: () => {} }), /not empty/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
