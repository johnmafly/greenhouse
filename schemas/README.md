# Schemas

JSON Schemas (draft 2020-12) for every Greenhouse file, validated with ajv (+ ajv-formats).
YAML files are parsed with the `yaml` package (YAML 1.2 core schema, so dates stay strings).

| Schema | File | Written by |
|---|---|---|
| `intake.schema.json` | `portfolio/<slug>/intake.yaml` | Chief drafts, owner approves |
| `claims.schema.json` | `claims.yaml` in the project repo | Chief |
| `submission.schema.json` | `portfolio/<slug>/rounds/NN/submission.yaml` | `greenhouse submit` |
| `checks.schema.json` | `rounds/NN/checks.json` | `greenhouse check` |
| `review.schema.json` | `rounds/NN/reviews/<n>.json` | Panel reviewers |
| `score.schema.json` | `rounds/NN/score.json` | `greenhouse score` |
| `rubric.schema.json` | `rubric/rubric-vN.yaml` | Owner / VC Joe |

Every document carries `schema_version: 1` (except `claims.yaml` and rubrics). Unknown
properties are rejected. A few rules JSON Schema cannot express are checked in code
(`cli/src/lib/schemas.ts`): unique claim, gate and finding ids; `checks.all_green` is true
exactly when no gate has status `fail`; `finished_at` is not before `started_at`; a finding's
dimension is one the review scored; rubric weights sum to 1.

Defaults are filled in on validation: `intake.budget.rounds` is 6 when omitted.

## Use from code

```ts
import { validate, assertValid, readDocument } from "../cli/src/lib/schemas.ts";
import type { Checks, Review, Score } from "../cli/src/lib/schemas.ts";
import { loadRubric } from "../cli/src/lib/rubric.ts";
import { computeScore, scoreRoundDir, CAP_GATES } from "../cli/src/lib/score.ts";

const checks = assertValid<Checks>("checks", readDocument(path), path); // throws ValidationError
```

## CLI

```bash
node cli/src/main.ts validate portfolio/<slug>/intake.yaml            # schema inferred from the name
node cli/src/main.ts validate --schema review some/file.json           # exit 0 valid, 1 invalid, 2 usage
node cli/src/main.ts score --round-dir portfolio/<slug>/rounds/01       # writes rounds/01/score.json
node cli/src/main.ts score --round-dir portfolio/<slug>/rounds/01 --check  # audit: recompute, compare bytes
```

## Scoring rules (`greenhouse score`, rubric v2, decision 0004)

- **Inputs** must agree or the round is not scored (exit 1): submission and checks share
  slug, round, sha and deployment URL; every review uses the rubric's version, the same brief
  version and the same evidence bundle (and `checks.bundle_hash` when set); every review scores
  exactly the rubric's dimensions within the scale; at least `panel.reviewers` (3) reviewers
  from at least `panel.min_families` (2) model families, with unique reviewer ids.
- **Dimension medians** across reviewers; with an even count, the mean of the two middle scores.
- **Composite** = weighted mean of the medians. **Reviewer composites** = weighted mean of
  each reviewer's own scores. All numbers are rounded to 3 decimals, and thresholds are compared
  on the rounded values.
- **Caps** (one entry per reason, lowest first; the composite takes the lowest max):
  - 7.0 (`quality`): any failed gate, reason `failed_gate:<id>`, except these named gates:
    `claims` → `unsupported_claim`, `critical-assumptions` → `untested_critical_assumption`,
    `intake-drift` → `intake_drift`, `reduced-motion` → `motion_ignores_reduced_motion`.
  - 6.0 (`sameness`): a strict majority of the panel (2 of 3, 3 of 4, 3 of 5) sets
    `flags.template_structure`, reason `template_sameness`: the structure or look is template
    output (a stock hero + feature grid + pricing table, the owner's example sections used as the
    fixed skeleton, or near-identical to the template or a portfolio sibling).
  - 5.0 (`integrity`): a failed `social-proof`, `reviewer-instruction` or `canary` gate, or any
    one reviewer setting `flags.invented_social_proof` / `flags.reviewer_instruction`
    (reasons `invented_social_proof`, `reviewer_instruction`, `canary_leak`). A `canary_leak` is
    a suspected breach: the integrity cap has `report_to_owner: true`, and the judge's ruling
    reports it to the owner (score.json records only the reason).
- **gates_green**: `all_green` and no failed gate (`warn` and `skip` do not fail).
- **graduation_eligible**: not provisional, gates green, composite ≥ 9.0, every dimension
  median ≥ 8.0, the rubric's `graduation.focus_dimensions` (v2: `design_identity`,
  `motion_interaction`, `copy_voice`, `distinctness`) each with a median ≥ `focus_median_min`
  (8.5), every reviewer composite ≥ 8.5.
- **Rubric version**: v2 is current (`CURRENT_RUBRIC_VERSION`, the loader's default). v1 was
  retired before any round was scored on it and is only in git history; a review that says
  `rubric_version: 1` is refused.
- **provisional** is true unless `--validated` is passed (judge validation tests 1 to 5 pass).
  A provisional score never graduates.
- **Determinism**: output depends only on the input files and flags. `decided_at` defaults to
  `checks.finished_at` (override with `--decided-at`); panel and hashes are sorted; same inputs
  give byte-identical `score.json`. `inputs` records the sha256 of `checks.json` and of each
  review file (keyed by file name) and the evidence bundle hash.
