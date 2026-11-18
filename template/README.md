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
| `greenhouse.yaml` | `slug`, `build.command`, `build.output`, `production_branch: main`, the `content` map (where each of the seven required pieces of content lives), the `cost_model` the pricing gate reconciles your prices with, and the `docs` block (where each of the thirteen user-guide sections lives). Set `slug`; point `content` and `docs` at your own pages; replace the example tiers with your own. |
| `site/` | The example site: `/`, the user guide under `/docs/` (thirteen sections plus a comparison page), `/pricing/`, `/signup/`, `404.html`. Only `/`, `/.well-known/greenhouse.json` and a 404 page are fixed routes. |
| `site/_headers` | `X-Robots-Tag: noindex` on every path until the owner publishes. |
| `scripts/build.mjs` | `npm run build`: copies `site/` to `dist/`, writes `/.well-known/greenhouse.json` with the commit sha (`CF_PAGES_COMMIT_SHA`, else `git rev-parse HEAD`) and the slug from `greenhouse.yaml`, and publishes the guide for agents: a Markdown copy of each `docs:` page (`/docs/<page>.md`), `/llms.txt` and `/llms-full.txt`. |
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

## Product voice

Write the site as a shipping product, in present tense. `product-voice` fails on hedged or
hypothetical framing ("planned", "by design", "the proposal", "concept", "demo", "coming soon" and
the rest of the list in `docs/package-contract.md`) in page text, meta tags, alt text, JSON-LD,
JavaScript strings, `llms.txt` and linked text files. Where a fact cannot be sourced, cut the
sentence rather than hedge it (decision 0005).

## Preflight

```bash
greenhouse check --repo .                       # build from a clean checkout, serve locally, run every gate
greenhouse check --repo . --url https://<slug>.example.com   # check the deployment instead
```

## User guide

Every project ships a full user guide (decision 0006): overview and concepts, architecture with a
diagram, features, quickstart, configuration, integrations, an API reference covering every
operation in `spec/openapi.yaml`, SDK reference, your domain reference, self-hosting and
operations, security model, FAQ and changelog. `docs:` in `greenhouse.yaml` says where each
section lives. The `docs` gate checks each section against a word floor, and checks that every
docs page has a Markdown version listed in `/llms.txt` and carried in `/llms-full.txt`, and that
headings have stable `id`s. The example guide here is Example Seed's; write your own product's
guide in its own structure.
