import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("greenhouse --help prints usage", () => {
  const r = spawnSync(process.execPath, ["cli/src/main.ts", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /greenhouse <command>/);
});
