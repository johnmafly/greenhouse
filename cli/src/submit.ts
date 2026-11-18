// greenhouse submit: open a judged round. Runs `greenhouse check` first and refuses on failure,
// computes the next round number, writes portfolio/<slug>/rounds/NN/submission.yaml on branch
// submission/<slug>-NN in a local clone of the control repo, and opens a ready pull request
// titled "submission: <slug> round NN" with `gh pr create`.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./capture-manifest.ts";
import { formatRound } from "./submit-guard.ts";
import { SLUG_RE, serializeSubmission, validateSubmission, type Submission } from "./submit-schema.ts";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_BRANCH = "main";

const USAGE = `greenhouse submit --project <repo path> --slug <slug> --url <deployment> [options]

Runs greenhouse check first and refuses on failure, then adds
portfolio/<slug>/rounds/NN/submission.yaml on branch submission/<slug>-NN of the control repo
and opens a ready pull request "submission: <slug> round NN".

Options:
  --project <path>        The project repo (its HEAD commit is what gets judged)
  --slug <slug>           Project slug
  --url <url>             Deployment URL of that commit
  --changelog <text>      What changed since the last round (hidden from reviewers)
  --changelog-file <f>    Same, read from a file
  --control <path>        Local clone of the control repo (default: the clone this CLI runs from)
  --dry-run               Print what would happen; change nothing
`;

export type RunResult = { status: number | null; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => RunResult;

export const run: Runner = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

function must(r: RunResult, what: string): string {
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-5).join(" | ")}`);
  return r.stdout;
}

/** Next round: one past the highest round already on the base branch or on a submission branch. */
export function nextRound(slug: string, roundDirs: string[], remoteBranches: string[]): number {
  let max = 0;
  for (const d of roundDirs) {
    const name = d.split("/").filter(Boolean).pop() ?? "";
    if (/^\d+$/.test(name)) max = Math.max(max, Number(name));
  }
  const re = new RegExp(`^(?:refs/heads/)?submission/${slug.replace(/[-]/g, "\\-")}-(\\d+)$`);
  for (const b of remoteBranches) {
    const m = re.exec(b.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** owner/name from an https or ssh GitHub remote URL. */
export function repoFromRemote(url: string): string {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) throw new Error(`cannot read owner/name from remote '${url.trim()}'`);
  return `${m[1]}/${m[2]}`;
}

export type CheckOutcome = { status: "pass" | "fail" | "unavailable"; detail: string };
export type Deps = {
  run: Runner;
  runCheck: (project: string, url: string) => CheckOutcome;
  createPr: (args: { repo: string; branch: string; title: string; body: string; cwd: string }) => string;
  log: (msg: string) => void;
};

/** Runs this CLI's own `check` command; any non-zero exit refuses the submission. */
export function defaultRunCheck(project: string, url: string): CheckOutcome {
  const r = run(process.execPath, [join(CLI_ROOT, "cli", "src", "main.ts"), "check", "--repo", project, "--url", url], { cwd: project });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  const tail = out.split("\n").slice(-15).join("\n");
  if (r.status === 0) return { status: "pass", detail: tail };
  if (r.status === 2 && /not implemented/.test(out)) return { status: "unavailable", detail: "this CLI has no 'check' command yet (issue #5)" };
  return { status: "fail", detail: tail || `exit ${r.status}` };
}

export function defaultCreatePr(a: { repo: string; branch: string; title: string; body: string; cwd: string }): string {
  const r = run("gh", ["pr", "create", "--repo", a.repo, "--base", BASE_BRANCH, "--head", a.branch, "--title", a.title, "--body-file", "-"], { cwd: a.cwd, input: a.body });
  return must(r, "gh pr create").trim().split("\n").pop() ?? "";
}

export type SubmitOptions = { project: string; slug: string; url: string; changelog: string; control: string; dryRun: boolean };
export type SubmitPlan = {
  round: number;
  branch: string;
  path: string;
  title: string;
  control_repo: string;
  submission: Submission;
  submission_yaml: string;
  check: CheckOutcome;
  would_refuse: boolean;
  pr_url?: string;
};

export async function submit(o: SubmitOptions, deps: Deps): Promise<SubmitPlan> {
  const { run: r } = deps;
  if (!SLUG_RE.test(o.slug)) throw new Error(`invalid slug '${o.slug}'`);
  const url = new URL(o.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("--url must be http(s)");

  // Project: what gets judged is its committed HEAD.
  const project = resolve(o.project);
  const sha = must(r("git", ["rev-parse", "HEAD"], { cwd: project }), "git rev-parse HEAD (project)").trim();
  const projectRepo = repoFromRemote(must(r("git", ["config", "--get", "remote.origin.url"], { cwd: project }), "reading remote.origin.url (project)"));
  const claims = r("git", ["show", "HEAD:claims.yaml"], { cwd: project });
  if (claims.status !== 0) throw new Error("claims.yaml is not committed at the project's HEAD (package contract)");
  const dirty = must(r("git", ["status", "--porcelain"], { cwd: project }), "git status (project)").trim();
  if (dirty) deps.log(`note: the project has uncommitted changes; only commit ${sha.slice(0, 12)} is submitted`);

  // Control repo: next round from main and from existing submission branches.
  const control = resolve(o.control);
  const controlRepo = repoFromRemote(must(r("git", ["config", "--get", "remote.origin.url"], { cwd: control }), "reading remote.origin.url (control)"));
  must(r("git", ["fetch", "--quiet", "origin", BASE_BRANCH], { cwd: control }), `git fetch origin ${BASE_BRANCH}`);
  const ls = r("git", ["ls-tree", "-d", "--name-only", `origin/${BASE_BRANCH}`, `portfolio/${o.slug}/rounds/`], { cwd: control });
  const roundDirs = ls.status === 0 ? ls.stdout.split("\n").filter(Boolean) : [];
  const heads = must(r("git", ["ls-remote", "--heads", "origin", `refs/heads/submission/${o.slug}-*`], { cwd: control }), "git ls-remote");
  const branches = heads.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[1]);
  const round = nextRound(o.slug, roundDirs, branches);
  const nn = formatRound(round);
  const branch = `submission/${o.slug}-${nn}`;
  const path = `portfolio/${o.slug}/rounds/${nn}/submission.yaml`;
  const title = `submission: ${o.slug} round ${nn}`;

  const submission: Submission = {
    schema_version: 1,
    slug: o.slug,
    round,
    repo: projectRepo,
    sha,
    deployment_url: o.url,
    claims_sha256: sha256(claims.stdout),
    changelog: o.changelog,
  };
  const v = validateSubmission(submission);
  if (!v.valid) throw new Error(`submission.yaml would be invalid:\n  ${v.errors.join("\n  ")}`);
  const submissionYaml = serializeSubmission(submission);

  deps.log(`running greenhouse check on ${project} against ${o.url} ...`);
  const check = deps.runCheck(project, o.url);
  const plan: SubmitPlan = { round, branch, path, title, control_repo: controlRepo, submission, submission_yaml: submissionYaml, check, would_refuse: check.status !== "pass" };
  if (o.dryRun) return plan;
  if (check.status !== "pass") throw new RefusedError(`greenhouse check did not pass (${check.status}); refusing to submit.\n${check.detail}`, plan);

  // Write the file on a fresh branch from origin/main in a temporary worktree, so the
  // caller's checkout of the control repo is never touched.
  const wt = await mkdtemp(join(tmpdir(), "greenhouse-submit-"));
  try {
    must(r("git", ["worktree", "add", "--quiet", "-b", branch, wt, `origin/${BASE_BRANCH}`], { cwd: control }), "git worktree add");
    await mkdir(join(wt, dirname(path)), { recursive: true });
    await writeFile(join(wt, path), submissionYaml);
    must(r("git", ["add", path], { cwd: wt }), "git add");
    must(r("git", ["commit", "--quiet", "-m", title], { cwd: wt }), "git commit");
    // Never force: if another submission took this branch name meanwhile, the push fails.
    must(r("git", ["push", "--quiet", "origin", `${branch}:refs/heads/${branch}`], { cwd: wt }), "git push");
    const body = [
      `Round ${nn} for \`${o.slug}\`, opened by \`greenhouse submit\`.`,
      "",
      `- Project: ${projectRepo} at \`${sha}\``,
      `- Deployment: ${o.url}`,
      `- Preflight: \`greenhouse check\` passed`,
      "",
      "```yaml",
      submissionYaml.trimEnd(),
      "```",
    ].join("\n");
    plan.pr_url = deps.createPr({ repo: controlRepo, branch, title, body, cwd: wt });
    return plan;
  } finally {
    r("git", ["worktree", "remove", "--force", wt], { cwd: control });
    r("git", ["branch", "-D", branch], { cwd: control });
    await rm(wt, { recursive: true, force: true });
  }
}

export class RefusedError extends Error {
  plan: SubmitPlan;
  constructor(msg: string, plan: SubmitPlan) {
    super(msg);
    this.plan = plan;
  }
}

export async function main(argv: string[], deps?: Partial<Deps>): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        slug: { type: "string" },
        url: { type: "string" },
        changelog: { type: "string" },
        "changelog-file": { type: "string" },
        control: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }).values;
  } catch (e) {
    process.stderr.write(`greenhouse submit: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.project || !args.slug || !args.url) {
    process.stderr.write(`greenhouse submit: --project, --slug and --url are required\n\n${USAGE}`);
    return 2;
  }
  if (args.changelog !== undefined && args["changelog-file"] !== undefined) {
    process.stderr.write("greenhouse submit: use --changelog or --changelog-file, not both\n");
    return 2;
  }
  const log = (m: string) => process.stderr.write(`${m}\n`);
  try {
    const changelog = args["changelog-file"] ? (await readFile(args["changelog-file"], "utf8")).trim() : (args.changelog ?? "");
    const plan = await submit(
      { project: args.project, slug: args.slug, url: args.url, changelog, control: args.control ?? CLI_ROOT, dryRun: !!args["dry-run"] },
      { run, runCheck: defaultRunCheck, createPr: defaultCreatePr, log, ...deps },
    );
    if (args["dry-run"]) {
      process.stdout.write(`${JSON.stringify({ dry_run: true, ...plan, refuse_reason: plan.would_refuse ? `greenhouse check: ${plan.check.status}` : null, would_do: [`git worktree add -b ${plan.branch} <tmp> origin/${BASE_BRANCH}`, `write ${plan.path}`, `git commit -m "${plan.title}"`, `git push origin ${plan.branch}`, `gh pr create --repo ${plan.control_repo} --base ${BASE_BRANCH} --head ${plan.branch} --title "${plan.title}"`] }, null, 2)}\n`);
      return plan.would_refuse ? 1 : 0;
    }
    process.stdout.write(`${plan.pr_url}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`greenhouse submit: ${(e as Error).message}\n`);
    return 1;
  }
}
