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
import { contentType, parseR2Target, uploadBundle } from "../src/capture-r2.ts";
import { CONTRACT_ROUTES, capture, parseRoutes, routeName } from "../src/capture.ts";
import { CONTENT_KEYS, loadContentMap, parseContentMap, routesFromContentMap, stripAnchor, type ContentMap } from "../src/capture-routes.ts";
import { motionTargets, pageSlug, stripPositions, type MotionEntry } from "../src/capture-motion.ts";
import { WEBKIT_DIR, collectWebkitEvidence, type WebkitEvidence } from "../src/capture-webkit.ts";
import { validate } from "../src/lib/schemas.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "capture-content-map");
// A round dir as `greenhouse check --round-dir` leaves it: checks.json with a webkit-iphone gate
// (/ clean, /how-it-works/ with one problem) and its two fold screenshots.
const WEBKIT_ROUND = join(import.meta.dirname, "fixtures", "capture-webkit", "round");

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

describe("content map routes (contract v2)", () => {
  const map: ContentMap = {
    how_it_works: "/how-it-works/",
    getting_started: "/docs/start/",
    architecture: "/docs/architecture/",
    integration: "/docs/start/#integrate",
    comparison: "/vs/",
    pricing: "/#plans",
    signup: "/try/",
  };

  test("'/' first, then distinct paths in content-key order, anchors stripped", () => {
    const { routes } = routesFromContentMap(map);
    assert.deepEqual(routes, ["/", "/how-it-works/", "/docs/start/", "/docs/architecture/", "/vs/", "/try/"]);
    // Order follows the keys, not the YAML: a map listing signup first still puts it last.
    const { signup, ...rest } = map;
    const reordered: ContentMap = { signup, ...rest };
    assert.equal(Object.keys(reordered)[0], "signup");
    assert.deepEqual(routesFromContentMap(reordered).routes, routes);
  });

  test("each page records the content keys it serves, anchors kept", () => {
    const { serves } = routesFromContentMap(map);
    assert.deepEqual(serves.get("/"), [{ key: "pricing", target: "/#plans" }]);
    assert.deepEqual(serves.get("/docs/start/"), [
      { key: "getting_started", target: "/docs/start/" },
      { key: "integration", target: "/docs/start/#integrate" },
    ]);
    assert.deepEqual(serves.get("/try/"), [{ key: "signup", target: "/try/" }]);
    const all = [...serves.values()].flat().map((s) => s.key).sort();
    assert.deepEqual(all, [...CONTENT_KEYS].sort());
  });

  test("everything on one page collapses to '/'", () => {
    const one = Object.fromEntries(CONTENT_KEYS.map((k) => [k, `/#${k}`])) as ContentMap;
    const r = routesFromContentMap(one);
    assert.deepEqual(r.routes, ["/"]);
    assert.equal(r.serves.get("/")!.length, 7);
    assert.equal(stripAnchor("/a/?x=1#b"), "/a/?x=1");
  });

  test("no content map means fallback (null), a malformed one is an error", () => {
    assert.equal(parseContentMap({ slug: "x" }), null);
    assert.equal(parseContentMap(null), null);
    assert.deepEqual(parseContentMap({ content: map }), map);
    assert.throws(() => parseContentMap({ content: null }), /content must be a mapping/);
    assert.throws(() => parseContentMap({ content: ["/"] }), /content must be a mapping/);
    assert.throws(() => parseContentMap(["x"]), /top level must be a mapping/);
    const { signup: _s, ...missing } = map;
    assert.throws(() => parseContentMap({ content: missing }), /content\.signup is missing/);
    assert.throws(() => parseContentMap({ content: { ...map, pricing: "pricing/" } }), /content\.pricing must be a site path/);
    assert.throws(() => parseContentMap({ content: { ...map, pricing: "//evil.test/" } }), /content\.pricing must be a site path/);
    assert.throws(() => parseContentMap({ content: { ...map, pricing: 3 } }), /content\.pricing must be a string/);
    assert.throws(() => parseContentMap({ content: { ...map, pricng: "/p/" } }), /unknown key content\.pricng/);
  });

  test("loads greenhouse.yaml from a file or a checkout directory", async () => {
    const byDir = await loadContentMap(FIXTURES);
    assert.equal(byDir.file, join(FIXTURES, "greenhouse.yaml"));
    assert.deepEqual(byDir.map, map);
    assert.equal((await loadContentMap(join(FIXTURES, "no-content.yaml"))).map, null);
    await assert.rejects(loadContentMap(join(FIXTURES, "malformed.yaml")), /malformed content map: unknown key content\.pricng; content\.getting_started must be a site path .*content\.signup is missing/);
    await assert.rejects(loadContentMap(join(FIXTURES, "nope.yaml")), /no such file/);
  });
});

describe("motion evidence helpers", () => {
  test("targets are home and the signup start, deduplicated", () => {
    assert.deepEqual(motionTargets("/signup/"), [{ page: "/", roles: ["home"] }, { page: "/signup/", roles: ["signup"] }]);
    assert.deepEqual(motionTargets("/#signup"), [{ page: "/", roles: ["home", "signup"] }]);
    assert.equal(pageSlug("/docs/try/"), "docs-try");
    assert.equal(pageSlug("/"), "home");
  });
  test("strip positions are evenly spaced, top and bottom included", () => {
    assert.deepEqual(stripPositions(1100, 12), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
    assert.deepEqual(stripPositions(0, 3), [0, 0, 0]);
    assert.equal(stripPositions(5000, 12).length, 12);
  });
  test("R2 content types cover the new files", () => {
    assert.equal(contentType("motion/home-desktop-scroll.webm"), "video/webm");
    assert.equal(contentType("motion/home-desktop-strip.png"), "image/png");
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
  test("a malformed content map, or one combined with --routes, is a usage error", () => {
    const out = join(tmpdir(), "gh-never-written");
    const bad = spawnSync(process.execPath, ["cli/src/main.ts", "capture", "--url", "http://x.test/", "--out", out, "--greenhouse-yaml", join(FIXTURES, "malformed.yaml")], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /malformed content map/);
    const both = spawnSync(process.execPath, ["cli/src/main.ts", "capture", "--url", "http://x.test/", "--out", out, "--greenhouse-yaml", FIXTURES, "--routes", "/"], { encoding: "utf8" });
    assert.equal(both.status, 2);
    assert.match(both.stderr, /mutually exclusive/);
    assert.equal(existsSync(out), false);
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

// Short motion timing so the browser tests stay quick (production: ~13.5 s videos, 600 ms settle).
const FAST_MOTION = { holdTopMs: 200, scrollMs: 1500, holdBottomMs: 200, stepMs: 50, settleMs: 40 };

function pngSize(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.subarray(1, 4).toString("latin1"), "PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

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
    const m = await capture({ url: `http://127.0.0.1:${port}/`, out, routes: ["/", "/docs/", "/missing/"], motion: FAST_MOTION, log: () => {} });
    assert.match(m.bundle_hash!, /^[0-9a-f]{64}$/);
    assert.deepEqual((m.deployment as { slug: string }).slug, "fixture");
    const pages = m.pages as { route: string; status: number; files: { desktop: string; mobile: string; text: string } }[];
    assert.deepEqual(pages.map((p) => [p.route, p.status]), [["/", 200], ["/docs/", 200], ["/missing/", 404]]);
    // 3 routes x (desktop, mobile, text) + well-known + 9 motion files
    assert.equal(m.files.length, 19);
    const v = await verifyBundle(out);
    assert.deepEqual(v.errors, []);
    assert.equal(m.schema_version, 3);
    assert.equal(m.route_source, "routes_option");
    assert.equal(m.webkit_iphone, null, "no webkit screenshots without --round-dir/--evidence-dir");
    assert.equal((m.pages as { content: unknown }[])[0].content, null);

    // Motion: home and /signup/ (fallback signup start), desktop and phone, plus one reduced-motion strip.
    const motion = m.motion as MotionEntry[];
    const summary = motion.map((e) => `${e.kind} ${e.page} ${e.viewport}`).sort();
    assert.deepEqual(summary, [
      "frame_strip / desktop",
      "frame_strip / mobile",
      "frame_strip /signup/ desktop",
      "frame_strip /signup/ mobile",
      "frame_strip_reduced_motion / desktop",
      "scroll_video / desktop",
      "scroll_video / mobile",
      "scroll_video /signup/ desktop",
      "scroll_video /signup/ mobile",
    ]);
    const hashes = new Map(m.files.map((f) => [f.path, f]));
    for (const e of motion) {
      const f = hashes.get(e.path);
      assert.ok(f, `${e.path} is in manifest files[]`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.bytes > 1000, `${e.path} is not empty`);
      assert.equal(e.status, 200);
      assert.ok(e.duration_ms > 0);
      if (e.kind === "scroll_video") {
        assert.equal((await readFile(join(out, e.path))).readUInt32BE(0), 0x1a45dfa3, "webm (EBML) header");
        assert.equal(e.frames, null);
        assert.ok(e.duration_ms >= 1900, "video covers hold + scroll + hold");
      } else {
        assert.equal(e.frames, 12);
        assert.equal(e.scroll_positions![0], 0);
        assert.ok(e.scroll_positions![11] > 1000, "the fixture page scrolls");
        assert.equal(e.scroll_positions![11], e.page_height - e.viewport_size.height, "last frame is at the bottom");
        assert.deepEqual([...e.scroll_positions!].sort((a, b) => a - b), e.scroll_positions);
        const size = pngSize(await readFile(join(out, e.path)));
        assert.equal(size.width, e.layout!.columns * e.layout!.frame_size.width + (e.layout!.columns + 1) * 10);
        assert.ok(size.height > e.layout!.rows * e.layout!.frame_size.height);
      }
    }
    const reduced = motion.find((e) => e.kind === "frame_strip_reduced_motion")!;
    assert.deepEqual([reduced.page, reduced.viewport, reduced.reduced_motion], ["/", "desktop", true]);

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

    // Tampering with a motion file fails verification.
    await writeFile(join(out, reduced.path), "x");
    assert.ok((await verifyBundle(out)).errors.includes(`sha256 mismatch: ${reduced.path}`));

    // The CLI refuses to overwrite an existing bundle.
    await assert.rejects(capture({ url: `http://127.0.0.1:${port}/`, out, routes: ["/"], motion: false, log: () => {} }), /not empty/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capture follows the content map and records what each page serves [browser]", { skip: browserSkip }, async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end(PAGE(`Page ${req.url}`, `<p id="plans">Plans</p><div class="tall"></div>`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), "gh-capture-map-"));
  const out = join(root, "bundle");
  try {
    const { map } = await loadContentMap(FIXTURES);
    const m = await capture({ url: `http://127.0.0.1:${port}/`, out, contentMap: map, motion: { ...FAST_MOTION, scrollMs: 500, frames: 4 }, log: () => {} });
    assert.equal(m.route_source, "content_map");
    assert.deepEqual(m.content_map, map);
    const pages = m.pages as { route: string; content: { key: string; target: string }[] }[];
    assert.deepEqual(pages.map((p) => p.route), ["/", "/how-it-works/", "/docs/start/", "/docs/architecture/", "/vs/", "/try/"]);
    assert.deepEqual(pages[0].content, [{ key: "pricing", target: "/#plans" }]);
    assert.deepEqual(pages[2].content.map((c) => c.target), ["/docs/start/", "/docs/start/#integrate"]);
    // Motion uses content.signup as the signup start.
    const motion = m.motion as MotionEntry[];
    assert.deepEqual([...new Set(motion.map((e) => e.page))], ["/", "/try/"]);
    assert.ok(motion.every((e) => e.kind === "scroll_video" || e.frames === 4));
    assert.ok(!seen.some((u) => u.startsWith("/signup")), "no v1 routes visited");
    assert.deepEqual((await verifyBundle(out)).errors, []);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe("webkit-iphone evidence (greenhouse check's iPhone screenshots)", () => {
  test("the fixture checks.json is a valid checks document", async () => {
    const doc = JSON.parse(await readFile(join(WEBKIT_ROUND, "checks.json"), "utf8"));
    assert.equal(validate("checks", doc).valid, true);
  });

  test("a round dir: copies every PNG and takes routes, problems and the gate result from checks.json", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gh-webkit-"));
    try {
      const ev = await collectWebkitEvidence({ roundDir: WEBKIT_ROUND }, tmp, ["/"]);
      assert.deepEqual(ev, {
        source: "round_dir",
        engine: "webkit",
        device: "iPhone 15 Pro",
        checked_sha: "a".repeat(40),
        gate: { status: "fail", summary: "1 of 2 routes break in WebKit (iPhone 15 Pro): /how-it-works/: stylesheet has no CSS rules: /site.css" },
        screenshots: [
          { route: "/", path: "webkit-iphone/home.png", problems: [] },
          { route: "/how-it-works/", path: "webkit-iphone/how-it-works.png", problems: ["stylesheet has no CSS rules: /site.css"] },
        ],
        notes: [],
      } satisfies WebkitEvidence);
      for (const f of ["home.png", "how-it-works.png"]) {
        assert.deepEqual(await readFile(join(tmp, WEBKIT_DIR, f)), await readFile(join(WEBKIT_ROUND, "evidence", WEBKIT_DIR, f)));
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("an evidence dir (check without --round-dir): routes matched by file name, no gate", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gh-webkit-"));
    try {
      const ev = await collectWebkitEvidence({ evidenceDir: join(WEBKIT_ROUND, "evidence") }, tmp, ["/", "/docs/"]);
      assert.equal(ev.source, "evidence_dir");
      assert.equal(ev.gate, null);
      assert.equal(ev.checked_sha, null);
      assert.deepEqual(ev.screenshots, [
        { route: "/", path: "webkit-iphone/home.png", problems: null },
        { route: null, path: "webkit-iphone/how-it-works.png", problems: null },
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("no screenshots is a note, not an error; a non-PNG is refused; other files are ignored", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gh-webkit-"));
    const round = await mkdtemp(join(tmpdir(), "gh-webkit-round-"));
    try {
      const none = await collectWebkitEvidence({ roundDir: round }, tmp, ["/"]);
      assert.deepEqual(none.screenshots, []);
      assert.match(none.notes.join("\n"), /no checks.json with a webkit-iphone gate/);
      assert.match(none.notes.join("\n"), /webkit-iphone\/ does not exist/);
      assert.equal(existsSync(join(tmp, WEBKIT_DIR)), false);

      await mkdir(join(round, "evidence", WEBKIT_DIR), { recursive: true });
      await writeFile(join(round, "evidence", WEBKIT_DIR, "notes.txt"), "x");
      const ignored = await collectWebkitEvidence({ roundDir: round }, tmp, ["/"]);
      assert.deepEqual(ignored.screenshots, []);
      assert.match(ignored.notes.join("\n"), /ignored webkit-iphone\/notes.txt/);

      await writeFile(join(round, "evidence", WEBKIT_DIR, "home.png"), "not a png");
      await assert.rejects(collectWebkitEvidence({ roundDir: round }, tmp, ["/"]), /is not a PNG/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await rm(round, { recursive: true, force: true });
    }
  });

  test("the CLI refuses --round-dir with --evidence-dir, and a round dir that does not exist", () => {
    const cli = join(import.meta.dirname, "..", "src", "main.ts");
    const both = spawnSync(process.execPath, [cli, "capture", "--url", "http://127.0.0.1:1/", "--out", join(tmpdir(), "gh-never"), "--round-dir", WEBKIT_ROUND, "--evidence-dir", WEBKIT_ROUND], { encoding: "utf8" });
    assert.equal(both.status, 2);
    assert.match(both.stderr, /mutually exclusive/);
    const missing = spawnSync(process.execPath, [cli, "capture", "--url", "http://127.0.0.1:1/", "--out", join(tmpdir(), "gh-never"), "--round-dir", join(tmpdir(), "gh-no-such-round")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /does not exist/);
  });

  test("capture puts the screenshots in the bundle, hashed, and records them in the manifest [browser]", { skip: browserSkip }, async () => {
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/greenhouse.json") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ slug: "fixture", sha: "b".repeat(40), built_at: "2026-11-18T00:00:00Z" }));
      }
      res.setHeader("content-type", "text/html");
      res.end(PAGE(`Page ${req.url}`, `<p>${req.url}</p>`));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const root = await mkdtemp(join(tmpdir(), "gh-capture-webkit-"));
    const out = join(root, "bundle");
    try {
      const m = await capture({ url: `http://127.0.0.1:${port}/`, out, routes: ["/", "/how-it-works/"], webkit: { roundDir: WEBKIT_ROUND }, motion: false, log: () => {} });
      assert.equal(m.schema_version, 3);
      const ev = m.webkit_iphone as WebkitEvidence;
      assert.deepEqual(ev.screenshots.map((s) => [s.route, s.path]), [["/", "webkit-iphone/home.png"], ["/how-it-works/", "webkit-iphone/how-it-works.png"]]);
      assert.equal(ev.gate?.status, "fail");
      // The fixture checks.json is for sha aaaa..., the deployment reports bbbb...: noted, not fatal.
      assert.match(ev.notes.join("\n"), /differs from the deployed sha/);
      const files = new Map(m.files.map((f) => [f.path, f]));
      for (const s of ev.screenshots) {
        const buf = await readFile(join(WEBKIT_ROUND, "evidence", s.path));
        assert.equal(files.get(s.path)?.sha256, sha256(buf), `${s.path} is hashed in files[]`);
      }
      assert.deepEqual((await verifyBundle(out)).errors, []);
      await writeFile(join(out, "webkit-iphone/home.png"), "x");
      assert.ok((await verifyBundle(out)).errors.includes("sha256 mismatch: webkit-iphone/home.png"));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
