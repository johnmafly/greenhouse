#!/usr/bin/env node
// greenhouse CLI entry point. Subcommands are implemented in their own modules
// (see issues): check, capture, submit, score, board.
const [cmd] = process.argv.slice(2);
const USAGE = `greenhouse <command>

Commands:
  check    Run every deterministic gate against a project (preflight)
  capture  Freeze an evidence bundle for a judged round
  submit   Open a submission pull request in the control repo
  score    Compute score.json from reviews and checks
  board    Build the static board (same as npm run board:build)
`;
if (!cmd || cmd === "--help" || cmd === "-h") {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (cmd === "capture") process.exit(await (await import("./capture.ts")).main(process.argv.slice(3)));
if (cmd === "submit") process.exit(await (await import("./submit.ts")).main(process.argv.slice(3)));
process.stderr.write(`greenhouse: '${cmd}' is not implemented yet\n`);
process.exit(2);
