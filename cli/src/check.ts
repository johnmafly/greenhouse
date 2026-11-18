// greenhouse check --repo <path> [--url <deployment>] [--round-dir <dir>] [--canary-file <f>]
//                  [--assisted --judge <id>=<family>:<command> --judge ... [--archive-dir <dir>]]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { greenhouseHome } from "./check/lock.ts";
import { judgePairProblem, parseJudgeSpec } from "./check/judge.ts";
import { CheckUsageError, runCheck } from "./check/run.ts";

export const CHECK_USAGE = `greenhouse check --repo <path> [--url <deployment>] [--round-dir <dir>] [--canary-file <f>]
                 [--out <file>] [--sha <sha>] [--round <n>] [--lighthouse-runs <n>] [--sibling <checks.json>]...
                 [--assisted --judge <id>=<family>:<command> --judge <id>=<family>:<command> [--archive-dir <dir>]]

Runs every deterministic gate against a project package and writes checks.json:
  build, package-files, claim-links, deployed-sha, routes, links, page-structure, placeholder, noindex,
  spec-samples, template-likeness, secrets, canary, asset-cache, axe, signup-flow, reduced-motion,
  no-js-content, webkit-iphone, lighthouse.

Routes, the crawl, no-js-content, the signup start and Lighthouse follow the content map in
greenhouse.yaml (contract v2); without one they fall back to the v1 route list (warn).
--sibling (repeatable) compares template-likeness with another project's checks.json.
webkit-iphone saves a fold screenshot per route under <round-dir>/evidence/webkit-iphone/
(without --round-dir: ~/.greenhouse/evidence/<slug>-<sha12>/webkit-iphone/).

--assisted adds the assisted gates: claims, claim-sweep, pricing, social-proof,
reviewer-instruction, hidden-text. They need two --judge commands from different model families;
each reads a judge request (JSON) on stdin and writes {"answer": "yes"|"no"|"unclear",
"reason": "..."} on stdout. Claim sources are archived under --archive-dir (default
<round-dir>/sources, else ~/.greenhouse/archive/<slug>-<sha12>).

The repo is built from a clean checkout of the commit (default: HEAD, or the sha in
<round-dir>/submission.yaml). Without --url (or a submission deployment_url) the build output
is served locally, the way Cloudflare Pages serves it (_headers included), and checked there.

Writes <round-dir>/checks.json, else --out, else ~/.greenhouse/checks/<slug>-<sha12>.json.
Exit 0 when no gate fails, 1 when any gate fails, 2 on a usage or internal error.
`;

export async function run(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        url: { type: "string" },
        "round-dir": { type: "string" },
        "canary-file": { type: "string" },
        out: { type: "string" },
        sha: { type: "string" },
        round: { type: "string" },
        "lighthouse-runs": { type: "string" },
        sibling: { type: "string", multiple: true },
        assisted: { type: "boolean", default: false },
        judge: { type: "string", multiple: true },
        "archive-dir": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    process.stderr.write(`greenhouse check: ${(e as Error).message}\n\n${CHECK_USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(CHECK_USAGE);
    return 0;
  }
  const usage = (m: string) => {
    process.stderr.write(`greenhouse check: ${m}\n\n${CHECK_USAGE}`);
    return 2;
  };
  if (!values.repo) return usage("--repo is required");
  const int = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(v)) throw new CheckUsageError(`${name} must be a positive integer`);
    return Number(v);
  };
  let assisted;
  if (values.assisted || values.judge?.length || values["archive-dir"]) {
    if (!values.assisted) return usage("--judge and --archive-dir need --assisted");
    let judges;
    try {
      judges = (values.judge ?? []).map(parseJudgeSpec);
    } catch (e) {
      return usage((e as Error).message);
    }
    const problem = judgePairProblem(judges);
    if (problem) return usage(`--assisted ${problem}`);
    assisted = { judges, archiveDir: values["archive-dir"] };
  }
  try {
    const checks = await runCheck({
      repo: values.repo,
      url: values.url,
      roundDir: values["round-dir"],
      canaryFile: values["canary-file"],
      sha: values.sha,
      round: int(values.round, "--round"),
      lighthouseRuns: int(values["lighthouse-runs"], "--lighthouse-runs"),
      siblings: values.sibling,
      assisted,
      log: (line) => process.stderr.write(line + "\n"),
    });
    const out = resolve(
      values["round-dir"] ? join(values["round-dir"], "checks.json") : values.out ?? join(greenhouseHome(), "checks", `${checks.slug}-${checks.sha.slice(0, 12)}.json`),
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(checks, null, 2) + "\n");
    const failed = checks.gates.filter((g) => g.status === "fail").map((g) => g.id);
    process.stderr.write(`\n${checks.all_green ? "all green" : `FAILED: ${failed.join(", ")}`} — wrote ${out}\n`);
    return checks.all_green ? 0 : 1;
  } catch (e) {
    if (e instanceof CheckUsageError) return usage(e.message);
    process.stderr.write(`greenhouse check: ${(e as Error).stack ?? e}\n`);
    return 2;
  }
}
