// greenhouse validate <file>... [--schema <name>]
import { parseArgs } from "node:util";
import { SCHEMA_NAMES, validateFile } from "./lib/schemas.ts";
import type { SchemaName } from "./lib/schemas.ts";

export const VALIDATE_USAGE = `greenhouse validate <file>... [--schema <${SCHEMA_NAMES.join("|")}>]

Validates Greenhouse files against schemas/*.schema.json. The schema is inferred from the
file name (intake.yaml, claims.yaml, submission.yaml, checks.json, reviews/*.json,
score.json, rubric-vN.yaml) unless --schema is given. Exit 0 valid, 1 invalid, 2 usage error.
`;

export function run(argv: string[]): number {
  let values;
  let files: string[];
  try {
    ({ values, positionals: files } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { schema: { type: "string" }, help: { type: "boolean", short: "h", default: false } },
    }));
  } catch (e) {
    process.stderr.write(`greenhouse validate: ${(e as Error).message}\n\n${VALIDATE_USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(VALIDATE_USAGE);
    return 0;
  }
  if (files.length === 0) {
    process.stderr.write(VALIDATE_USAGE);
    return 2;
  }
  const schema = values.schema as SchemaName | undefined;
  if (schema !== undefined && !(SCHEMA_NAMES as readonly string[]).includes(schema)) {
    process.stderr.write(`greenhouse validate: unknown schema '${schema}'\n`);
    return 2;
  }
  let status = 0;
  for (const file of files) {
    try {
      const r = validateFile(file, schema);
      if (r.valid) {
        process.stdout.write(`ok ${file} (${r.schema})\n`);
      } else {
        process.stdout.write(`invalid ${file} (${r.schema}):\n  ${r.errors.join("\n  ")}\n`);
        status = Math.max(status, 1);
      }
    } catch (e) {
      process.stderr.write(`greenhouse validate: ${file}: ${(e as Error).message}\n`);
      status = 2;
    }
  }
  return status;
}
