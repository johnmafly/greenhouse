// greenhouse score --round-dir portfolio/<slug>/rounds/NN
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { scoreRoundDir } from "./lib/score.ts";

export const SCORE_USAGE = `greenhouse score --round-dir <portfolio/<slug>/rounds/NN> [options]

Computes score.json from submission.yaml, checks.json and reviews/*.json.

Options:
  --rubric <file>       Rubric to score with (default: rubric/rubric-v<N>.yaml, N from the reviews)
  --validated           Judge validation tests 1 to 5 pass: score is not provisional
                        (default: provisional, which never graduates)
  --cost-usd <n>        Model cost of the round (default: null)
  --decided-at <iso>    Timestamp to record (default: checks.json finished_at, for determinism)
  --out <file>          Where to write (default: <round-dir>/score.json); '-' for stdout
  --check               Do not write; exit 1 if the existing score.json differs byte for byte
`;

export function run(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "round-dir": { type: "string" },
        rubric: { type: "string" },
        validated: { type: "boolean", default: false },
        "cost-usd": { type: "string" },
        "decided-at": { type: "string" },
        out: { type: "string" },
        check: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    process.stderr.write(`greenhouse score: ${(e as Error).message}\n\n${SCORE_USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(SCORE_USAGE);
    return 0;
  }
  const dir = values["round-dir"];
  if (!dir) {
    process.stderr.write(`greenhouse score: --round-dir is required\n\n${SCORE_USAGE}`);
    return 2;
  }
  let costUsd: number | null = null;
  if (values["cost-usd"] !== undefined) {
    costUsd = Number(values["cost-usd"]);
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      process.stderr.write(`greenhouse score: --cost-usd must be a non-negative number\n`);
      return 2;
    }
  }
  let json: string;
  let composite: number;
  let provisional: boolean;
  let eligible: boolean;
  try {
    const r = scoreRoundDir(dir, {
      rubricPath: values.rubric,
      provisional: !values.validated,
      costUsd,
      decidedAt: values["decided-at"],
    });
    json = r.json;
    ({ composite, provisional, graduation_eligible: eligible } = r.score);
  } catch (e) {
    process.stderr.write(`greenhouse score: ${(e as Error).message}\n`);
    return 1;
  }
  const out = values.out ?? join(dir, "score.json");
  if (values.check) {
    const same = existsSync(out) && readFileSync(out, "utf8") === json;
    process.stdout.write(same ? `ok ${out} matches\n` : `differs ${out}\n`);
    return same ? 0 : 1;
  }
  if (out === "-") {
    process.stdout.write(json);
  } else {
    writeFileSync(out, json);
    process.stdout.write(`wrote ${out}: composite ${composite}${provisional ? " (provisional)" : ""}, graduation_eligible ${eligible}\n`);
  }
  return 0;
}
