// npm run board:build: reads portfolio/, ops/ and rubric/ and writes the static board to board/dist.
// Options (for tests and previews): --portfolio <dir> --ops <dir> --out <dir>.
//
// Routes: / (leaderboard), /projects/<slug>/, /judge/, /ops/, 404.html (Cloudflare Pages serves it
// with status 404 for unknown paths), /.well-known/greenhouse.json ({slug, sha, built_at}; sha from
// CF_PAGES_COMMIT_SHA). Static files in board/public (including _headers: X-Robots-Tag noindex,
// decision 0001) are copied as-is; a second _headers rule adds the Content-Security-Policy.
//
// Refuses to build (exit 1, nothing written) when any input fails its schema or a score.json
// input hash does not match its files (see board/src/data.ts).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadRubric } from "../cli/src/lib/rubric.ts";
import type { Rubric } from "../cli/src/lib/schemas.ts";
import { BoardInputError, loadBoardData } from "./src/data.ts";
import {
  INLINE_SCRIPT, judgePage, layout, leaderboardPage, notFoundPage, opsPage, projectPage,
} from "./src/render.ts";
import type { BuildInfo, Page, RenderContext } from "./src/render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BuildOptions {
  root?: string;
  portfolioDir?: string;
  opsDir?: string;
  rubricDir?: string;
  outDir?: string;
  publicDir?: string;
  env?: Record<string, string | undefined>;
  /** ISO 8601 build time; default now. */
  now?: string;
}

export interface BuildResult {
  outDir: string;
  files: string[];
  sha: string | null;
}

function commitSha(env: Record<string, string | undefined>, root: string): string | null {
  for (const v of [env.CF_PAGES_COMMIT_SHA, env.GITHUB_SHA]) if (v && /^[0-9a-f]{40}$/.test(v)) return v;
  if (env.GREENHOUSE_BOARD_NO_GIT) return null;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function evidenceBase(env: Record<string, string | undefined>): string | null {
  const v = env.GREENHOUSE_EVIDENCE_PUBLIC_BASE?.trim();
  if (!v) return null;
  if (!/^https:\/\/[^\s"'<>]+$/.test(v)) throw new Error("GREENHOUSE_EVIDENCE_PUBLIC_BASE must be an https:// URL");
  return v;
}

export function scriptHash(): string {
  return "sha256-" + createHash("sha256").update(INLINE_SCRIPT).digest("base64");
}

export const CSP = () =>
  [
    "default-src 'none'",
    "style-src 'self'",
    `script-src '${scriptHash()}'`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

export function buildBoard(opts: BuildOptions = {}): BuildResult {
  const root = opts.root ?? ROOT;
  const env = opts.env ?? process.env;
  const outDir = opts.outDir ?? join(root, "board", "dist");
  const publicDir = opts.publicDir ?? join(root, "board", "public");
  const rubricDir = opts.rubricDir ?? join(root, "rubric");

  // Read and verify everything before touching the output directory.
  const data = loadBoardData({
    portfolioDir: opts.portfolioDir ?? join(root, "portfolio"),
    opsDir: opts.opsDir ?? join(root, "ops"),
    rubricDir,
    root,
  });
  const rubrics = new Map<number, Rubric>();
  for (const f of existsSync(rubricDir) ? readdirSync(rubricDir) : []) {
    if (/^rubric-v\d+\.ya?ml$/.test(f)) {
      const r = loadRubric(join(rubricDir, f));
      rubrics.set(r.version, r);
    }
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const build: BuildInfo = {
    sha: commitSha(env, root),
    builtAt: opts.now ?? new Date().toISOString(),
    cliVersion: String(pkg.version),
    node: process.versions.node,
    evidenceBase: evidenceBase(env),
  };
  const ctx: RenderContext = { data, build, rubrics };

  const pages: Page[] = [
    leaderboardPage(ctx),
    ...data.projects.map((p) => projectPage(ctx, p)),
    judgePage(ctx),
    opsPage(ctx),
    notFoundPage(),
  ];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (existsSync(publicDir)) cpSync(publicDir, outDir, { recursive: true });
  const script = `<script>${INLINE_SCRIPT}</script>`;
  const files: string[] = [];
  const write = (rel: string, content: string) => {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    files.push(rel);
  };
  for (const page of pages) write(page.path, layout(ctx, page, script));
  write(
    ".well-known/greenhouse.json",
    JSON.stringify({ slug: "greenhouse", sha: build.sha, built_at: build.builtAt }, null, 2) + "\n",
  );
  // One `/*` rule only: Cloudflare Pages applied just the last of two `/*` rules, which dropped
  // X-Robots-Tag in production. So the build's headers (CSP allowing only the inline sweep-age
  // check by hash) join the existing `/*` rule from public/.
  const headersPath = join(outDir, "_headers");
  writeFileSync(
    headersPath,
    addToCatchAllRule(existsSync(headersPath) ? readFileSync(headersPath, "utf8") : "", [
      `Content-Security-Policy: ${CSP()}`,
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: no-referrer",
    ]),
  );
  return { outDir, files, sha: build.sha };
}

/** Append header lines to the `/*` rule of a _headers file, creating the rule if it is missing. */
export function addToCatchAllRule(headers: string, lines: string[]): string {
  const out = headers.replace(/\s*$/, "").split("\n");
  const start = out.findIndex((l) => l.trim() === "/*");
  const add = lines.map((l) => `  ${l}`);
  if (start === -1) return [...out.filter((l) => l !== ""), "/*", ...add, ""].join("\n");
  let end = start + 1;
  while (end < out.length && /^\s+\S/.test(out[end])) end++;
  out.splice(end, 0, ...add);
  return out.join("\n") + "\n";
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { portfolio: { type: "string" }, ops: { type: "string" }, out: { type: "string" } },
  });
  try {
    const r = buildBoard({
      portfolioDir: values.portfolio && resolve(values.portfolio),
      opsDir: values.ops && resolve(values.ops),
      outDir: values.out && resolve(values.out),
    });
    console.log(`board: ${r.files.length} files written to ${r.outDir} (commit ${r.sha ?? "unknown"})`);
  } catch (e) {
    if (e instanceof BoardInputError) {
      console.error(`board: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
