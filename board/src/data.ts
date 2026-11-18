// Board inputs: reads portfolio/*/intake.yaml and portfolio/<slug>/rounds/NN/*, validates every
// file against its schema (#4) and checks that each score.json's input hashes match the files
// beside it. Any problem is collected and the build refuses (BoardInputError), so the board never
// shows a score that does not trace to the committed checks and reviews.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assertValid, parseDocument, ValidationError } from "../../cli/src/lib/schemas.ts";
import type { Checks, Intake, Review, Score, Submission } from "../../cli/src/lib/schemas.ts";
import { sha256 } from "../../cli/src/lib/score.ts";

export interface ReviewFile {
  file: string;
  review: Review;
}

export interface RoundData {
  round: number;
  /** Directory name, e.g. "01". */
  name: string;
  submission: Submission;
  checks: Checks | null;
  score: Score | null;
  reviews: ReviewFile[];
  /** ruling.md source, or null while the judge has not ruled. */
  ruling: string | null;
}

export interface ProjectData {
  intake: Intake;
  rounds: RoundData[];
}

export interface SweepState {
  last_sweep_at: string;
  summary?: string;
}

export type JudgeTestStatus = "not-run" | "pass" | "fail" | "running";
export interface JudgeTest {
  id: number;
  name: string;
  what: string;
  status: JudgeTestStatus;
  last_run: string | null;
  summary: string | null;
}

export interface JudgeState {
  validated: boolean;
  tests: JudgeTest[];
}

export interface BoardData {
  projects: ProjectData[];
  sweep: SweepState | null;
  judge: JudgeState;
  rubricVersion: number | null;
}

export class BoardInputError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`board inputs are inconsistent; refusing to build:\n  ${problems.join("\n  ")}`);
    this.name = "BoardInputError";
    this.problems = problems;
  }
}

/** Plan v7 section 7: the judge is provisional until tests 1 to 5 pass; 6 never stops. */
export const JUDGE_TESTS: { id: number; name: string; what: string }[] = [
  { id: 1, name: "Agreement with you", what: "The panel's order matches the owner's blind pairwise choices, on a holdout it never tuned on." },
  { id: 2, name: "Planted defects", what: "Known defects planted in reference builds are found and score below the bar." },
  { id: 3, name: "Repeatability", what: "Re-judging the same bundle lands within the pass margin." },
  { id: 4, name: "Gaming", what: "Instructions aimed at reviewers and invented social proof are caught and capped." },
  { id: 5, name: "History-blindness", what: "Scores do not rise with round number alone; the panel never sees earlier rulings." },
  { id: 6, name: "Live acceptance", what: "The owner's cold reads agree with graduations. Runs for ever." },
];

const JUDGE_STATUSES: readonly string[] = ["not-run", "pass", "fail", "running"];

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

export interface LoadOptions {
  portfolioDir: string;
  opsDir: string;
  rubricDir: string;
  /** Used only to shorten paths in error messages. */
  root?: string;
}

export function loadBoardData(opts: LoadOptions): BoardData {
  const problems: string[] = [];
  const rel = (p: string) => (opts.root ? relative(opts.root, p) : p);

  function load<T>(path: string, schema: "intake" | "submission" | "checks" | "score" | "review"): { doc: T; bytes: Buffer } | null {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
      return { doc: assertValid<T>(schema, parseDocument(bytes.toString("utf8"), path), rel(path)), bytes };
    } catch (e) {
      problems.push(e instanceof ValidationError ? e.message.replace(/\n\s*/g, "; ") : `${rel(path)}: ${(e as Error).message}`);
      return null;
    }
  }

  const projects: ProjectData[] = [];
  const slugs = isDir(opts.portfolioDir)
    ? readdirSync(opts.portfolioDir).filter((d) => isDir(join(opts.portfolioDir, d))).sort()
    : [];
  for (const dirSlug of slugs) {
    const pdir = join(opts.portfolioDir, dirSlug);
    const intakePath = ["intake.yaml", "intake.yml"].map((f) => join(pdir, f)).find(existsSync);
    if (!intakePath) {
      problems.push(`${rel(pdir)}: no intake.yaml`);
      continue;
    }
    const intake = load<Intake>(intakePath, "intake")?.doc;
    if (!intake) continue;
    if (intake.slug !== dirSlug) problems.push(`${rel(intakePath)}: slug '${intake.slug}' does not match its folder '${dirSlug}'`);

    const rounds: RoundData[] = [];
    const rdir = join(pdir, "rounds");
    const names = isDir(rdir) ? readdirSync(rdir).filter((d) => isDir(join(rdir, d))).sort() : [];
    for (const name of names) {
      const dir = join(rdir, name);
      if (!/^\d{2,}$/.test(name)) {
        problems.push(`${rel(dir)}: round folders are named NN (01, 02, ...)`);
        continue;
      }
      const subPath = join(dir, "submission.yaml");
      if (!existsSync(subPath)) {
        problems.push(`${rel(dir)}: no submission.yaml`);
        continue;
      }
      const submission = load<Submission>(subPath, "submission")?.doc;
      if (!submission) continue;
      if (submission.slug !== intake.slug) problems.push(`${rel(subPath)}: slug '${submission.slug}' is not '${intake.slug}'`);
      if (submission.round !== Number(name)) problems.push(`${rel(subPath)}: round ${submission.round} does not match its folder '${name}'`);

      const checksPath = join(dir, "checks.json");
      const checksRead = existsSync(checksPath) ? load<Checks>(checksPath, "checks") : null;
      const checks = checksRead?.doc ?? null;
      if (checks) {
        for (const k of ["slug", "round", "sha"] as const) {
          if (checks[k] !== submission[k]) problems.push(`${rel(checksPath)}: ${k} '${checks[k]}' does not match submission.yaml '${submission[k]}'`);
        }
      }

      const reviewsDir = join(dir, "reviews");
      const reviewFiles = isDir(reviewsDir) ? readdirSync(reviewsDir).filter((f) => f.endsWith(".json")).sort() : [];
      const reviews: ReviewFile[] = [];
      const reviewBytes = new Map<string, Buffer>();
      for (const file of reviewFiles) {
        const r = load<Review>(join(reviewsDir, file), "review");
        if (!r) continue;
        reviews.push({ file, review: r.doc });
        reviewBytes.set(file, r.bytes);
      }

      const scorePath = join(dir, "score.json");
      const score = existsSync(scorePath) ? (load<Score>(scorePath, "score")?.doc ?? null) : null;
      if (score) {
        const at = rel(scorePath);
        for (const k of ["slug", "round", "sha"] as const) {
          if (score[k] !== submission[k]) problems.push(`${at}: ${k} '${score[k]}' does not match submission.yaml '${submission[k]}'`);
        }
        if (!checksRead) problems.push(`${at}: inputs.checks_sha256 cannot be verified, ${rel(checksPath)} is missing`);
        else if (sha256(checksRead.bytes) !== score.inputs.checks_sha256) {
          problems.push(`${at}: inputs.checks_sha256 ${score.inputs.checks_sha256} does not match checks.json (${sha256(checksRead.bytes)})`);
        }
        if (checks?.bundle_hash !== undefined && checks.bundle_hash !== score.inputs.bundle_hash) {
          problems.push(`${at}: inputs.bundle_hash does not match checks.json bundle_hash`);
        }
        const listed = Object.keys(score.inputs.reviews_sha256).sort();
        for (const file of listed) {
          const bytes = reviewBytes.get(file);
          if (!bytes) {
            if (!reviewFiles.includes(file)) problems.push(`${at}: inputs.reviews_sha256 lists reviews/${file}, which is missing`);
            continue;
          }
          const actual = sha256(bytes);
          if (actual !== score.inputs.reviews_sha256[file]) {
            problems.push(`${at}: inputs.reviews_sha256["${file}"] does not match reviews/${file} (${actual})`);
          }
        }
        for (const file of reviewFiles) {
          if (!listed.includes(file)) problems.push(`${at}: reviews/${file} is not among the scored inputs`);
        }
      }

      const rulingPath = join(dir, "ruling.md");
      const ruling = existsSync(rulingPath) ? readText(rulingPath) : null;
      if (ruling !== null && !score) problems.push(`${rel(rulingPath)}: a ruling without score.json`);

      rounds.push({ round: Number(name), name, submission, checks, score, reviews, ruling });
    }
    projects.push({ intake, rounds });
  }

  const sweep = loadSweep(join(opts.opsDir, "sweep.json"), problems, rel);
  const judge = loadJudge(join(opts.opsDir, "judge.json"), problems, rel);
  const rubricVersion = latestRubric(opts.rubricDir);

  if (problems.length) throw new BoardInputError(problems);
  return { projects, sweep, judge, rubricVersion };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** ops/sweep.json, written by the daily sweep: {"last_sweep_at": "<ISO 8601>", "summary"?: "..."}. */
function loadSweep(path: string, problems: string[], rel: (p: string) => string): SweepState | null {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readText(path));
    if (typeof doc?.last_sweep_at !== "string" || !ISO_RE.test(doc.last_sweep_at)) {
      problems.push(`${rel(path)}: last_sweep_at must be an ISO 8601 date-time with a zone`);
      return null;
    }
    return { last_sweep_at: doc.last_sweep_at, summary: typeof doc.summary === "string" ? doc.summary : undefined };
  } catch (e) {
    problems.push(`${rel(path)}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * ops/judge.json (optional; written by the judge in phase 2):
 * {"tests": [{"id": 1..6, "status": "not-run|running|pass|fail", "last_run": ISO|null, "summary": "..."}]}.
 * Missing file or test: "not-run". validated = tests 1 to 5 all pass.
 */
function loadJudge(path: string, problems: string[], rel: (p: string) => string): JudgeState {
  const tests: JudgeTest[] = JUDGE_TESTS.map((t) => ({ ...t, status: "not-run", last_run: null, summary: null }));
  if (existsSync(path)) {
    try {
      const doc = JSON.parse(readText(path));
      for (const t of Array.isArray(doc?.tests) ? doc.tests : []) {
        const target = tests.find((x) => x.id === t?.id);
        if (!target) {
          problems.push(`${rel(path)}: unknown judge test id ${JSON.stringify(t?.id)}`);
          continue;
        }
        if (!JUDGE_STATUSES.includes(t.status)) problems.push(`${rel(path)}: test ${t.id} status must be one of ${JUDGE_STATUSES.join(", ")}`);
        else target.status = t.status;
        target.last_run = typeof t.last_run === "string" ? t.last_run : null;
        target.summary = typeof t.summary === "string" ? t.summary : null;
      }
    } catch (e) {
      problems.push(`${rel(path)}: ${(e as Error).message}`);
    }
  }
  return { validated: tests.filter((t) => t.id <= 5).every((t) => t.status === "pass"), tests };
}

function latestRubric(dir: string): number | null {
  if (!isDir(dir)) return null;
  const versions = readdirSync(dir)
    .map((f) => /^rubric-v(\d+)\.ya?ml$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  return versions.length ? Math.max(...versions) : null;
}

// ---- Derived values the pages show ----

export function scoredRounds(p: ProjectData): (RoundData & { score: Score })[] {
  return p.rounds.filter((r): r is RoundData & { score: Score } => r.score !== null);
}

export function latestScore(p: ProjectData): Score | null {
  const s = scoredRounds(p);
  return s.length ? s[s.length - 1].score : null;
}

export function spendUsd(p: ProjectData): number {
  return scoredRounds(p).reduce((sum, r) => sum + (r.score.cost_usd ?? 0), 0);
}

export function spendKnown(p: ProjectData): boolean {
  return scoredRounds(p).some((r) => r.score.cost_usd !== null);
}

/** Composite change from the first to the latest scored round, divided by the rounds between. */
export function pointsPerRound(p: ProjectData): number | null {
  const s = scoredRounds(p);
  if (s.length < 2) return null;
  return (s[s.length - 1].score.composite - s[0].score.composite) / (s.length - 1);
}

/** Latest round's change against the one before. */
export function lastGain(p: ProjectData): number | null {
  const s = scoredRounds(p);
  if (s.length < 2) return null;
  return s[s.length - 1].score.composite - s[s.length - 2].score.composite;
}

/** Spend per composite point gained since round 1; null when unknown or nothing gained. */
export function costPerPoint(p: ProjectData): number | null {
  const s = scoredRounds(p);
  if (s.length < 2 || !spendKnown(p)) return null;
  const gained = s[s.length - 1].score.composite - s[0].score.composite;
  return gained > 0 ? spendUsd(p) / gained : null;
}

/** A round is open from its submission until the judge writes ruling.md. */
export function isOpen(r: RoundData): boolean {
  return r.ruling === null;
}

export function roundsUsed(p: ProjectData): number {
  return p.rounds.length;
}

export interface NextAction {
  text: string;
  owner: "chief" | "judge" | "owner" | "none";
}

export function nextAction(p: ProjectData): NextAction {
  const st = p.intake.status;
  if (st === "graduated") return { text: "Graduated. Owner publishes the site.", owner: "owner" };
  if (st === "killed") return { text: "Stopped by the owner.", owner: "none" };
  if (st === "paused") return { text: "Paused. Waiting for the owner.", owner: "owner" };
  const last = p.rounds[p.rounds.length - 1];
  if (!last) return { text: "Awaiting first round. The Chief builds, runs greenhouse check, then submits.", owner: "chief" };
  const nn = last.name;
  if (!last.checks) return { text: `Round ${nn} submitted. Judge runs the gates.`, owner: "judge" };
  if (!last.score) return { text: `Round ${nn} is with the reviewer panel.`, owner: "judge" };
  if (!last.ruling) return { text: `Round ${nn} scored. Judge writes the ruling.`, owner: "judge" };
  if (last.score.graduation_eligible) return { text: "Meets the bar. Owner cold read.", owner: "owner" };
  if (roundsUsed(p) >= p.intake.budget.rounds) {
    return { text: "Round budget used. Owner decides: continue, pivot, pause or kill.", owner: "owner" };
  }
  return { text: `Chief revises for round ${String(last.round + 1).padStart(2, "0")}.`, owner: "chief" };
}
