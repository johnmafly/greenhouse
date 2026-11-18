// path-guard: what a submission pull request may change.
//
// Run by .github/workflows/path-guard.yml (pull_request_target, base-branch code only).
// A PR whose title starts with "submission:" must be titled "submission: <slug> round NN" and
// must change exactly one file: portfolio/<slug>/rounds/NN/submission.yaml, added (a new round),
// whose slug and round match the title. Any other PR must not add or change a submission.yaml.
import { parseSubmissionYaml, validateSubmission, SLUG_RE } from "./submit-schema.ts";

export type ChangedFile = { filename: string; status: string; previous_filename?: string };
export type GuardResult = { submission: boolean; ok: boolean; errors: string[]; slug?: string; round?: number };

export const TITLE_PREFIX = "submission:";
const TITLE_RE = /^submission: ([a-z0-9][a-z0-9-]{0,62}) round (\d{2,})$/;
const SUBMISSION_FILE_RE = /^portfolio\/[^/]+\/rounds\/[^/]+\/submission\.yaml$/;

export function formatRound(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseSubmissionTitle(title: string): { slug: string; round: number } | null {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return null;
  const round = Number(m[2]);
  if (round < 1 || formatRound(round) !== m[2]) return null;
  return { slug: m[1], round };
}

export function guard(title: string, files: ChangedFile[], submissionYaml?: string | null): GuardResult {
  const errors: string[] = [];
  if (!title.trimStart().startsWith(TITLE_PREFIX)) {
    for (const f of files) {
      for (const name of [f.filename, f.previous_filename]) {
        if (name && SUBMISSION_FILE_RE.test(name)) errors.push(`${name}: only a 'submission:' pull request may add or change a submission.yaml`);
      }
    }
    return { submission: false, ok: errors.length === 0, errors };
  }

  const t = parseSubmissionTitle(title);
  if (!t) return { submission: true, ok: false, errors: [`title must be 'submission: <slug> round NN' (two-digit round from 01), got '${title}'`] };
  if (!SLUG_RE.test(t.slug)) errors.push(`invalid slug '${t.slug}'`);
  const dir = `portfolio/${t.slug}/rounds/${formatRound(t.round)}/`;
  const expected = `${dir}submission.yaml`;

  for (const f of files) {
    if (f.previous_filename && f.previous_filename !== f.filename) errors.push(`${f.previous_filename} -> ${f.filename}: renames are not allowed in a submission`);
    if (!f.filename.startsWith(dir)) errors.push(`${f.filename}: outside ${dir}`);
    else if (f.filename !== expected) errors.push(`${f.filename}: a submission may only add ${expected}`);
    else if (f.status !== "added") errors.push(`${f.filename}: must be added (status '${f.status}'); round ${formatRound(t.round)} already exists on the base branch`);
  }
  if (!files.some((f) => f.filename === expected && f.status === "added")) errors.push(`${expected} is not added by this pull request`);

  if (errors.length === 0) {
    if (submissionYaml == null) errors.push(`${expected}: content not available`);
    else {
      try {
        const doc = parseSubmissionYaml(submissionYaml);
        const v = validateSubmission(doc);
        for (const e of v.errors) errors.push(`${expected}${e}`);
        if (doc.slug !== t.slug) errors.push(`${expected}: slug '${String(doc.slug)}' does not match the title and path ('${t.slug}')`);
        if (doc.round !== t.round) errors.push(`${expected}: round ${String(doc.round)} does not match the title and path (${t.round})`);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  return { submission: true, ok: errors.length === 0, errors, slug: t.slug, round: t.round };
}

// ---- GitHub Actions entry point ----
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER. Reads the PR (title, head sha, files) through
// the REST API; never checks out or runs code from the pull request.

async function gh(path: string, token: string, accept = "application/vnd.github+json"): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "greenhouse-path-guard" },
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
  return res;
}

export async function runAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const number = env.PR_NUMBER;
  if (!token || !repo || !number) {
    process.stderr.write("path-guard: GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required\n");
    return 2;
  }
  const pr = (await (await gh(`/repos/${repo}/pulls/${number}`, token)).json()) as { title: string; head: { sha: string; repo: { full_name: string } | null } };
  const files: ChangedFile[] = [];
  for (let page = 1; ; page++) {
    const batch = (await (await gh(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token)).json()) as ChangedFile[];
    files.push(...batch.map((f) => ({ filename: f.filename, status: f.status, previous_filename: f.previous_filename })));
    if (batch.length < 100) break;
    if (page >= 30) throw new Error("pull request changes more than 3000 files");
  }
  let yaml: string | null = null;
  const t = parseSubmissionTitle(pr.title);
  if (t && pr.head.repo) {
    const path = `portfolio/${t.slug}/rounds/${formatRound(t.round)}/submission.yaml`;
    if (files.some((f) => f.filename === path)) {
      const res = await gh(`/repos/${pr.head.repo.full_name}/contents/${path}?ref=${pr.head.sha}`, token, "application/vnd.github.raw+json");
      yaml = await res.text();
    }
  }
  const r = guard(pr.title, files, yaml);
  const label = r.submission ? `submission PR (${files.length} changed file(s))` : "not a submission PR";
  if (r.ok) {
    process.stdout.write(`path-guard: pass: ${label}\n`);
    return 0;
  }
  process.stdout.write(`path-guard: FAIL: ${label}\n${r.errors.map((e) => `  - ${e}`).join("\n")}\n`);
  for (const e of r.errors) process.stdout.write(`::error::${e.replace(/\r?\n/g, " ")}\n`);
  return 1;
}

if (import.meta.main) {
  runAction().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`path-guard: ${(e as Error).message}\n`);
      process.exit(2);
    },
  );
}
