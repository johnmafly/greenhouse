// Clean-checkout build: clone the repo at the exact sha into a fresh folder, install, run
// greenhouse.yaml's build.command, and confirm build.output holds a site.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Gate } from "../lib/schemas.ts";
import { gate, readManifest } from "./gates.ts";
import type { CorpusFile, Manifest } from "./gates.ts";

export interface BuildResult {
  gate: Gate;
  /** Clean checkout of the sha, or null when the clone failed. */
  checkoutDir: string | null;
  /** Built site folder, or null when the build failed. */
  outputDir: string | null;
  manifest: Manifest | null;
}

/** Environment the project's build sees: no tokens from the caller, plus the Pages variables. */
export function buildEnv(sha: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "TZ", "NVM_DIR", "npm_config_cache"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, CI: "true", CF_PAGES: "1", CF_PAGES_COMMIT_SHA: sha, CF_PAGES_BRANCH: "main" };
}

export function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function tail(s: string, n = 3000): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const add = (b: Buffer) => {
      output = tail(output + b.toString("utf8"), 20_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(e), timedOut });
    });
  });
}

export async function cleanBuild(repo: string, sha: string, workDir: string, timeoutMs = 15 * 60_000): Promise<BuildResult> {
  const id = "build";
  const checkout = join(workDir, "checkout");
  const fail = (summary: string, details?: unknown, co: string | null = null, manifest: Manifest | null = null): BuildResult => ({
    gate: gate(id, "fail", summary, undefined, details),
    checkoutDir: co,
    outputDir: null,
    manifest,
  });
  const clone = git(["clone", "--quiet", "--no-checkout", "--no-hardlinks", repo, checkout]);
  if (!clone.ok) return fail("git clone of the repo failed", { git: tail(clone.out) });
  const co = git(["checkout", "--quiet", "--detach", sha], checkout);
  if (!co.ok) return fail(`commit ${sha} cannot be checked out`, { git: tail(co.out) });
  const { manifest, errors } = readManifest(checkout);
  if (!manifest) return fail(`cannot build: ${errors.join("; ")}`, { problems: errors }, checkout);

  const env = buildEnv(sha);
  const started = Date.now();
  const steps: { command: string; exit: number | null; seconds: number }[] = [];
  const run = async (command: string) => {
    const t = Date.now();
    const r = await sh(command, checkout, env, timeoutMs);
    steps.push({ command, exit: r.code, seconds: Math.round((Date.now() - t) / 100) / 10 });
    return r;
  };
  let install: string | null = null;
  if (existsSync(join(checkout, "package-lock.json"))) install = "npm ci --no-audit --no-fund";
  else if (existsSync(join(checkout, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) install = "npm install --no-audit --no-fund";
  }
  if (install) {
    const r = await run(install);
    if (r.code !== 0) return fail(r.timedOut ? `${install} timed out` : `${install} failed (exit ${r.code})`, { steps, log: tail(r.output) }, checkout, manifest);
  }
  const b = await run(manifest.build.command);
  if (b.code !== 0)
    return fail(b.timedOut ? `build command timed out after ${timeoutMs / 1000}s` : `build command failed (exit ${b.code}): ${manifest.build.command}`, { steps, log: tail(b.output) }, checkout, manifest);
  const out = join(checkout, manifest.build.output);
  if (!existsSync(out) || !statSync(out).isDirectory()) return fail(`build.output ${manifest.build.output}/ was not created`, { steps }, checkout, manifest);
  if (!existsSync(join(out, "index.html"))) return fail(`build.output ${manifest.build.output}/ has no index.html`, { steps }, checkout, manifest);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  return {
    gate: gate(id, "pass", `clean checkout of ${sha.slice(0, 12)} builds with \`${manifest.build.command}\` into ${manifest.build.output}/`, { seconds, files: listFiles(out).length }, { steps }),
    checkoutDir: checkout,
    outputDir: out,
    manifest,
  };
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** Text files for the secret and canary scans: committed files, then build output. Binary files are skipped. */
export function scanCorpus(checkoutDir: string | null, outputDir: string | null): CorpusFile[] {
  const files: CorpusFile[] = [];
  const read = (abs: string, label: string) => {
    const s = statSync(abs);
    if (!s.isFile() || s.size > MAX_SCAN_BYTES) return;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return;
    files.push({ name: label, text: buf.toString("utf8") });
  };
  if (checkoutDir) {
    const ls = spawnSync("git", ["ls-files", "-z"], { cwd: checkoutDir, encoding: "utf8" });
    for (const rel of (ls.stdout ?? "").split("\0").filter(Boolean)) {
      const abs = join(checkoutDir, rel);
      if (existsSync(abs)) read(abs, `repo:${rel}`);
    }
  }
  if (outputDir) for (const abs of listFiles(outputDir)) read(abs, `build:${relative(outputDir, abs)}`);
  return files;
}
