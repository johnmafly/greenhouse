// Fixtures for the greenhouse check tests: the template, copied and mutated one defect at a time.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../src/check/serve.ts";
import type { StaticServer } from "../src/check/serve.ts";
import { crawl } from "../src/check/site.ts";
import type { Site } from "../src/check/site.ts";

export const TEMPLATE = join(import.meta.dirname, "..", "..", "template");
export const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";

export function tmp(prefix = "gh-check-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function edit(file: string, fn: (s: string) => string): void {
  writeFileSync(file, fn(readFileSync(file, "utf8")));
}

/** The template's site/ as a built output folder (greenhouse.json written), optionally mutated. */
export function builtSite(mutate?: (dir: string) => void, sha = FAKE_SHA, slug = "example-seed"): string {
  const dir = tmp();
  cpSync(join(TEMPLATE, "site"), dir, { recursive: true });
  mkdirSync(join(dir, ".well-known"), { recursive: true });
  writeFileSync(join(dir, ".well-known", "greenhouse.json"), JSON.stringify({ slug, sha, built_at: "2026-11-18T00:00:00.000Z" }));
  mutate?.(dir);
  return dir;
}

export interface Served {
  dir: string;
  server: StaticServer;
  site: Site;
  close(): Promise<void>;
}

export async function serveSite(mutate?: (dir: string) => void): Promise<Served> {
  const dir = builtSite(mutate);
  const server = await serveStatic(dir);
  const site = await crawl(server.url);
  return { dir, server, site, close: () => server.close() };
}

/** The template as its own git repo (one commit), optionally mutated before the commit. */
export function templateRepo(mutate?: (dir: string) => void): { dir: string; sha: string } {
  const dir = tmp("gh-check-repo-");
  cpSync(TEMPLATE, dir, { recursive: true });
  mutate?.(dir);
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-qm", "fixture");
  return { dir, sha: g("rev-parse", "HEAD") };
}

/** Replace the signup page with the BotRampart-style stub: no steps, no final screen. */
export function stubSignup(dir: string): void {
  edit(join(dir, "signup", "index.html"), (s) =>
    s.replace(/<main>[\s\S]*<\/main>[\s\S]*?(?=\s*<\/body>)/, "<main>\n<h1>Sign up</h1>\n<p>A preview of signing up.</p>\n</main>\n<footer><p>Preview.</p></footer>"),
  );
}
