# Project template (package contract v1)

The unstyled starting point for a Greenhouse project repo. It implements every route and file in
[`docs/package-contract.md`](../docs/package-contract.md) and passes `greenhouse check` as is.
Visual design and all content are the Chief's.

| Path | What it is |
|---|---|
| `greenhouse.yaml` | `slug`, `build.command`, `build.output`, `production_branch: main`. Set `slug`. |
| `site/` | The static site: `/`, `/docs/` and its five sections, `/pricing/`, `/signup/`, `404.html`. |
| `site/_headers` | `X-Robots-Tag: noindex` on every path until the owner publishes. |
| `scripts/build.mjs` | `npm run build`: copies `site/` to `dist/` and writes `/.well-known/greenhouse.json` with the commit sha (`CF_PAGES_COMMIT_SHA`, else `git rev-parse HEAD`) and the slug from `greenhouse.yaml`. |
| `spec/openapi.yaml` | Build spec. Every `<pre><code data-op="…">` sample must name one of its `operationId`s. |
| `claims.yaml` | Claims ledger (`schemas/claims.schema.json`). |
| `STATE.md` | Decisions, open findings, next steps, spend. |

## Start a project

```bash
cp -R template/ ~/workspace/<chief>/<project>/ && cd ~/workspace/<chief>/<project>
git init -b main && git add -A && git commit -m "Start from the Greenhouse template"
# set slug in greenhouse.yaml, then replace every page's content
```

Cloudflare Pages: build command `npm run build`, output `dist`, production branch `main`.

## Mock signup convention

`greenhouse check` (gate `signup-flow`) walks `/signup/` in a browser: it fills the visible
fields, presses the visible `[data-signup-next]` (or `[data-next]`) control, or the visible form's submit button,
and repeats until a visible `[data-signup-final]` element appears. That final screen must say it
is a preview, and the flow must set no cookies or storage and send no non-GET request.

## Preflight

```bash
greenhouse check --repo .                       # build from a clean checkout, serve locally, run every gate
greenhouse check --repo . --url https://<slug>.example.com   # check the deployment instead
```
