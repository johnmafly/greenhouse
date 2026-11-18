// Builds the static site into dist/ and writes /.well-known/greenhouse.json
// (Greenhouse package contract v1). No dependencies.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "site");
const out = join(root, "dist");

// The slug comes from greenhouse.yaml so it is set in one place.
const slug = /^slug:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(readFileSync(join(root, "greenhouse.yaml"), "utf8"))?.[1];
if (!slug) throw new Error("greenhouse.yaml has no slug");

// Cloudflare Pages sets CF_PAGES_COMMIT_SHA; elsewhere use the checkout's HEAD.
function commitSha() {
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    throw new Error("No commit SHA: set CF_PAGES_COMMIT_SHA or build inside a git checkout");
  }
}

const sha = commitSha();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a full commit SHA: ${sha}`);

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
mkdirSync(join(out, ".well-known"), { recursive: true });
const info = { slug, sha, built_at: new Date().toISOString() };
writeFileSync(join(out, ".well-known", "greenhouse.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`dist/ built for ${slug} at ${sha}`);
