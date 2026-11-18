import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The board must stay unindexed until the owner publishes (docs/decisions/0000, 0001).
test("board build emits a _headers file that sends X-Robots-Tag: noindex on every path", () => {
  execFileSync(process.execPath, ["board/build.ts"], { stdio: "pipe" });
  const headers = readFileSync("board/dist/_headers", "utf8");
  const lines = headers.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.equal(lines[0], "/*", "first rule must match every path");
  assert.match(lines[1], /^\s+X-Robots-Tag:\s*noindex\b/i);
});
