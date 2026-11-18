# Project package contract (v1)

What every seed's project repo must ship so `greenhouse check` and a judged round can run.
The template in `template/` implements this structure with no visual design.

## Repository

| Path | Required | Notes |
|---|---|---|
| `site/` or the repo's static build output | yes | Static site served by Cloudflare Pages, built from `main` only. |
| `STATE.md` | yes | Decisions, open findings, next steps, spend. Kept current by the Chief. |
| `claims.yaml` | yes | Every public factual claim (schema: `schemas/claims.schema.json`). |
| `spec/openapi.yaml` (or `spec/interface.md` for non-HTTP products) | yes | The build spec docs samples are checked against. |
| `greenhouse.yaml` | yes | `slug`, `build.command`, `build.output`, `production_branch: main`. |

## Deployed routes

| Route | Content |
|---|---|
| `/` | Introduction site: beautiful and recognisably its own. |
| `/docs/` | Index linking the five sections below. |
| `/docs/how-it-works/` | How it works. |
| `/docs/comparison/` | Comparison with three or more vendors: fair, sourced, dated. |
| `/docs/getting-started/` | Getting started. |
| `/docs/architecture/` | Architecture. |
| `/docs/integration/` | Integration guide. |
| `/pricing/` | Free vs paid, self-hosting path, consistent with the open-source model. |
| `/signup/` | Mock signup through to a first-value screen. The last screen says it is a preview. Stores nothing. |
| `/.well-known/greenhouse.json` | `{"slug": "...", "sha": "<git commit sha>", "built_at": "<ISO 8601>"}` written at build time (Pages exposes `CF_PAGES_COMMIT_SHA`). |

## Rules checked by gates

- Every page has `<title>`, one `<h1>`, `lang` on `<html>`, no placeholder text (`lorem`, `TODO`, `TBD`, `[placeholder]`).
- No broken internal links. External links in `claims.yaml` must resolve.
- Code samples in docs that call the product use `<pre><code data-op="operationId">`; every `operationId` must exist in the spec.
- Sites are **public** (owner decision 2026-11-18) but send `X-Robots-Tag: noindex` (via `_headers`)
  and `<meta name="robots" content="noindex">` until the owner publishes at graduation.
- No invented testimonials, logos, customer counts or quotes.
- No text aimed at reviewers or hidden from humans.
- No secrets anywhere in the repo or the build output.
