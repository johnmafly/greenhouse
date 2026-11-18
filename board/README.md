# Board

`npm run board:build` turns the files in Git into the static site at `board/dist`, which
Cloudflare Pages (`greenhouse-board`, native Git integration, decision 0001) serves at
greenhouse.agenthatch.ai. The board keeps no state of its own.

| Route | Shows |
|---|---|
| `/` | Leaderboard: current composite, round-by-round line against the 9.0 bar, latest dimension medians against the 8.0 floor, gates, rounds used of budget, spend of cap, points gained per round and spend per point, status, next action. Sorted by score; projects without a score follow. |
| `/projects/<slug>/` | Every round (newest first): changelog, gates, dimension medians, panel, ruling (`ruling.md` rendered), findings by severity, evidence bundle hash; links to the live site, repo and commit. A project with no rounds shows "Awaiting first round". |
| `/judge/` | Judge report card: validation tests 1 to 6 and the versions in force (rubric, brief, CLI). |
| `/ops/` | Daily sweep age (red after 36 hours), open rounds, last ruling, judging spend this month, this build's commit. |
| `/404.html` | Served by Pages with status 404 for unknown paths. |
| `/.well-known/greenhouse.json` | `{"slug": "greenhouse", "sha": "<CF_PAGES_COMMIT_SHA>", "built_at": "<ISO 8601>"}` |

## Inputs

- `portfolio/<slug>/intake.yaml` and `portfolio/<slug>/rounds/NN/{submission.yaml, checks.json, reviews/*.json, score.json, ruling.md}`, validated with `cli/src/lib/schemas.ts` (#4). A round is open from its submission until `ruling.md` exists.
- `ops/sweep.json` (written by the daily sweep): `{"last_sweep_at": "<ISO 8601>", "summary": "..."}`. Missing means "no sweep yet" and shows red.
- `ops/judge.json` (optional, phase 2): `{"tests": [{"id": 1, "status": "not-run|running|pass|fail", "last_run": "<ISO 8601>|null", "summary": "..."}]}`. Missing tests are "not yet run"; the judge is validated when tests 1 to 5 pass.
- `rubric/rubric-vN.yaml` for dimension names and weights.
- Environment: `CF_PAGES_COMMIT_SHA` (set by Pages), `GREENHOUSE_EVIDENCE_PUBLIC_BASE` (optional https URL; when set, rounds link their evidence manifest `<base>/<slug>/NN/bundles/<bundle_hash>.json`; unset while the R2 bucket is private, so only the hash is shown).

## Refuses to build

Exit 1 and nothing written when any input fails its schema, a slug or round does not match its
folder, or a `score.json` input hash (`checks_sha256`, each `reviews_sha256`, `bundle_hash`)
does not match the files beside it.

## Security

No external scripts, styles, fonts or images. The only script is a small inline one that
re-checks the sweep age against the viewer's clock (so the board turns red without a rebuild);
`_headers` allows it by hash in a `Content-Security-Policy` with `default-src 'none'`. Every
value from an input file is HTML-escaped, including the ruling's Markdown. `noindex` is sent
both as `X-Robots-Tag` and as a meta tag.

## Preview locally

```bash
node board/build.ts --portfolio board/test/fixtures/portfolio --ops board/test/fixtures/ops --out /tmp/board
```
