# Project template (package contract v2)

**An unstyled, working example of the package contract, not a structure to copy.** It shows the
files `greenhouse check` reads ([`docs/package-contract.md`](../docs/package-contract.md)) and a
site that passes the deterministic gates. Its routes, nav (Home / Docs / Pricing / Sign up), page
outline and copy are placeholders for the mechanics only: the owner's example sections (pricing,
docs, compare) are content you must have, not a skeleton to follow. Design the site's
information architecture, visual identity, motion and voice around the product's own story, and
point the `content` map in `greenhouse.yaml` at wherever that content ends up.

A site that stays close to this template fails the `template-likeness` gate (similarity >= 0.8),
and reviewers cap template-shaped sites under the rubric's sameness cap.

| Path | What it is |
|---|---|
| `greenhouse.yaml` | `slug`, `build.command`, `build.output`, `production_branch: main`, and the `content` map (where each of the seven required pieces of content lives). Set `slug`; point `content` at your own pages. |
| `site/` | The example site: `/`, `/docs/` and its five sections, `/pricing/`, `/signup/`, `404.html`. Only `/`, `/.well-known/greenhouse.json` and a 404 page are fixed routes. |
| `site/_headers` | `X-Robots-Tag: noindex` on every path until the owner publishes. |
| `scripts/build.mjs` | `npm run build`: copies `site/` to `dist/` and writes `/.well-known/greenhouse.json` with the commit sha (`CF_PAGES_COMMIT_SHA`, else `git rev-parse HEAD`) and the slug from `greenhouse.yaml`. |
| `spec/openapi.yaml` | Build spec. Every `<pre><code data-op="…">` sample must name one of its `operationId`s. |
| `claims.yaml` | Claims ledger (`schemas/claims.schema.json`). |
| `STATE.md` | Decisions, open findings, next steps, spend. |

## Start a project

```bash
cp -R template/ ~/workspace/<chief>/<project>/ && cd ~/workspace/<chief>/<project>
git init -b main && git add -A && git commit -m "Start from the Greenhouse template"
# set slug in greenhouse.yaml, design your own pages, then point `content` at them
```

Cloudflare Pages: build command `npm run build`, output `dist`, production branch `main`.

## Mock signup convention

`greenhouse check` (gate `signup-flow`) walks the signup from `content.signup` in a browser: it fills the visible
fields, presses the visible `[data-signup-next]` (or `[data-next]`) control, or the visible form's submit button,
and repeats until a visible `[data-signup-final]` element appears. That final screen must say it
is a preview, and the flow must set no cookies or storage and send no non-GET request
(Cloudflare Web Analytics' same-origin `POST /cdn-cgi/rum` beacon is ignored).

## Motion guardrails

Motion is welcome (and scored), but `greenhouse check` requires that it degrades:

- `reduced-motion`: with `prefers-reduced-motion: reduce`, scrolling the home page runs no
  transform/opacity animation longer than 200 ms and no scroll-linked animation, and all text in
  view is visible. Wrap motion in `@media (prefers-reduced-motion: no-preference)` (or check
  `matchMedia` in JavaScript).
- `no-js-content`: with JavaScript disabled, every content section shows its text. Do not start
  scroll-reveal content at `opacity: 0` in CSS; hide it from a script (for example add a class
  to `<html>` first) so it stays visible when the script does not run.

## Preflight

```bash
greenhouse check --repo .                       # build from a clean checkout, serve locally, run every gate
greenhouse check --repo . --url https://<slug>.example.com   # check the deployment instead
```
