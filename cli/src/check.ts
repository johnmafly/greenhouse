// greenhouse check --repo <path> [--url <deployment>] [--round-dir <dir>] [--canary-file <f>]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { greenhouseHome } from "./check/lock.ts";
import { CheckUsageError, runCheck } from "./check/run.ts";

export const CHECK_USAGE = `greenhouse check --repo <path> [--url <deployment>] [--round-dir <dir>] [--canary-file <f>]
                 [--out <file>] [--sha <sha>] [--round <n>] [--lighthouse-runs <n>]

Runs every deterministic gate against a project package and writes checks.json:
  build, package-files, deployed-sha, routes, links, page-structure, placeholder, noindex,
  spec-samples, secrets, canary, axe, signup-flow, lighthouse.

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
  try {
    const checks = await runCheck({
      repo: values.repo,
      url: values.url,
      roundDir: values["round-dir"],
      canaryFile: values["canary-file"],
      sha: values.sha,
      round: int(values.round, "--round"),
      lighthouseRuns: int(values["lighthouse-runs"], "--lighthouse-runs"),
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
