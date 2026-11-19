# Greenhouse

Greenhouse takes funded open-source ideas from **Idea** to **Seed** to **Graduated**.
It is run by VC Joe (a Reason) for johnmafly. This is the **control repo**: rubric, schemas,
the `greenhouse` CLI, the unstyled project template, the board and every project's
round history under `portfolio/<slug>/`.

Design: [implementation plan v7](https://reasonmachines.com/agents/dfaf7012-741b-4320-8081-ed50a60f45f0?page=73e7343c-ee90-446f-ad6a-daf72a70e2f3).
Owner decisions that change v7 are recorded in [docs/decisions/0000-owner-decisions.md](docs/decisions/0000-owner-decisions.md).

## Layout

| Path | What |
|---|---|
| `rubric/` | The rubric in force (`rubric-v3.yaml`, decision 0008; `rubric-v2.yaml` kept for rounds judged on it). Weights, anchors, caps, graduation rule. |
| `schemas/` | JSON Schemas for every Greenhouse file (intake, submission, checks, review, score). |
| `cli/` | The `greenhouse` CLI: `check`, `capture`, `submit`, `score`, `board`. Same gate code for Chiefs and the judge. |
| `template/` | Unstyled project package template (structure only, never visual design). |
| `board/` | Static leaderboard generated from Git; deployed by Cloudflare Pages from this repo. |
| `portfolio/<slug>/` | `intake.yaml`, `rounds/NN/{submission.yaml,checks.json,reviews/,score.json,ruling.md}`, `feedback/`. |
| `docs/` | `package-contract.md` (what a project must ship), `design-bar.md` (what a good site looks like), `chief-brief.md`, `decisions/` (spikes and owner decisions). |
| `ops/runbooks/` | Stuck round, failed build, token rotation, adding or replacing a Chief, publishing. |

Judge material (reviewer briefs, validation set, answer key) lives in the private repo
`johnmafly/greenhouse-judge`, never here.

## Development

Requires Node 24+ (TypeScript runs through Node's native type stripping; no build step).

```bash
npm ci
npm test            # schema, scoring, CLI and board tests
npm run board:build # writes board/dist
node cli/src/main.ts --help
```

All changes land through pull requests with green CI on `main`.
