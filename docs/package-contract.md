# Project package contract (v2)

What every seed's project repo must ship so `greenhouse check` and a judged round can run.
v2 ([decision 0004](decisions/0004-design-bar-v2.md)) requires **content**, not **routes**: the
Chief designs the site's information architecture and declares where each required piece lives.
The template in `template/` is an unstyled, working example of the contract. Its routes are one
possible layout, not a structure to copy. How the site is judged is in
[design-bar.md](design-bar.md) and `rubric/rubric-v2.yaml`.

## Repository

| Path | Required | Notes |
|---|---|---|
| `site/` or the repo's static build output | yes | Static site served by Cloudflare Pages, built from `main` only. |
| `STATE.md` | yes | Decisions, open findings, next steps, spend. Kept current by the Chief. |
| `claims.yaml` | yes | Every public factual claim (schema: `schemas/claims.schema.json`). |
| `spec/openapi.yaml` (or `spec/interface.md` for non-HTTP products) | yes | The build spec docs samples are checked against. |
| `greenhouse.yaml` | yes | `slug`, `build.command`, `build.output`, `production_branch: main`, and the `content:` map below. |

## Fixed routes

Only these three are fixed:

| Route | Content |
|---|---|
| `/` | The introduction site's home: designed around this product's own story ([design-bar.md](design-bar.md)). |
| `/.well-known/greenhouse.json` | `{"slug": "...", "sha": "<git commit sha>", "built_at": "<ISO 8601>"}` written at build time (Pages exposes `CF_PAGES_COMMIT_SHA`). |
| 404 page | Unknown paths return status 404 with the site's own not-found page (Pages serves `404.html`), not the home page with 200. |

## Required content: the `content:` map

Every package covers the seven pieces of content below. Where they live is the Chief's design:
separate pages, sections of one page, or any mix. `greenhouse.yaml` declares each one as a site
path, optionally with a `#anchor`:

```yaml
content:            # each value: a site path, optionally with #anchor
  how_it_works: /how-it-works/
  getting_started: /docs/start/
  architecture: /docs/architecture/
  integration: /docs/integration/
  comparison: /vs/
  pricing: /#plans
  signup: /try/      # mock signup flow start; its last screen keeps data-signup-final
```

| Key | What it must contain |
|---|---|
| `how_it_works` | How the product works, for the target buyer. |
| `getting_started` | Getting started: the first steps an engineer takes. |
| `architecture` | Architecture: components, data flow, trust boundaries. |
| `integration` | Integration guide, with code samples tied to the spec. |
| `comparison` | Comparison with three or more vendors: fair, sourced, dated, including where a vendor is the better choice. |
| `pricing` | Free vs paid, the self-hosting path, consistent with the open-source model. |
| `signup` | Start of the mock signup, which goes through to a first-value screen. The last screen says it is a preview. Stores nothing. |

- All seven keys are required. Several keys may share a path (use anchors).
- Every path must return 200, and every `#anchor` must exist on its page as an element `id`.
- The checks crawl from `/` plus these paths; every page reached that way is checked.
- The example values above are just that. Choose names and a structure that fit the product's story.
  The owner's examples (pricing, docs, compare) are content to cover, not the nav or the skeleton.

## Rules checked by gates

- Every page has `<title>`, one `<h1>`, `lang` on `<html>`, no placeholder text (`lorem`, `TODO`, `TBD`, `[placeholder]`).
- Motion respects `prefers-reduced-motion` and content does not depend on JavaScript to become
  visible (`reduced-motion` and `no-js-content` gates; [design-bar.md](design-bar.md)).
- No broken internal links. External links in `claims.yaml` must resolve (`claim-links` gate):
  - 2xx/3xx after redirects: pass.
  - 401/403/429 ("refused automation"): `warn`, not fail, only if every claim citing the URL has a
    non-empty `quote` and a `checked` date within 30 days of the check run; otherwise fail. A 429 is
    retried once after a short backoff before it is classified.
  - 404/410/other 4xx/5xx, DNS error, timeout: fail.
  - The gate fails if more than 20% of the claim URLs refuse automation.
  - Each URL is requested with a browser User-Agent, `HEAD` first and `GET` when `HEAD` does not
    succeed. `checks.json` records every URL's status, class and citing claims so judges can
    spot-check the refused ones.
- Code samples in docs that call the product use `<pre><code data-op="operationId">`; every `operationId` must exist in the spec.
- Sites are **public** (owner decision 2026-11-18) but send `X-Robots-Tag: noindex` (via `_headers`)
  and `<meta name="robots" content="noindex">` until the owner publishes at graduation.
- No invented testimonials, logos, customer counts or quotes.
- No text aimed at reviewers or hidden from humans.
- No secrets anywhere in the repo or the build output.

## Mock signup markup

The signup flow (starting at `content.signup`) marks its flow so the `signup-flow` gate can walk it in a browser: each step's way
forward is a visible `[data-signup-next]` (or `[data-next]`) control, or the visible form's submit button, and the
last screen is a visible `[data-signup-final]` element whose text says it is a preview. The gate
fills visible fields with test values, and fails if the flow sets cookies or storage or sends a
non-GET request, except Cloudflare's same-origin Web Analytics beacon `POST /cdn-cgi/rum`. The
template's `/signup/` is a working example.

## greenhouse check

`greenhouse check --repo <path> [--url <deployment>] [--round-dir <dir>] [--canary-file <f>]` runs
these deterministic gates and writes `checks.json` (`schemas/checks.schema.json`) to `<round-dir>/`,
`--out`, or `~/.greenhouse/checks/<slug>-<sha12>.json`; it exits 1 if any gate fails. A gate that cannot run reports `fail` with the reason.

| Gate | Checks |
|---|---|
| `build` | Clean checkout of the sha; `npm ci` when a lockfile exists; `build.command` succeeds with `CF_PAGES_COMMIT_SHA` set and no caller tokens in its environment; `build.output/index.html` exists. |
| `package-files` | `greenhouse.yaml`, `STATE.md`, `claims.yaml` (schema-valid), `spec/openapi.yaml` or `spec/interface.md`. |
| `claim-links` | Every `source_url` in `claims.yaml` resolves, per the policy above (refused automation: `warn` when quoted and checked within 30 days; over 20% refused: fail). |
| `deployed-sha` | `/.well-known/greenhouse.json` reports the checked sha and slug. |
| `routes` | `/` and every `content:` path return HTML with status 200, every `#anchor` exists, and an unknown path returns 404. |
| `links` | Every same-origin link, image, script and stylesheet on every reachable page resolves. |
| `page-structure` | Every page has `lang`, a `<title>` and exactly one `<h1>`. |
| `placeholder` | No `lorem`, `TODO`, `TBD`, `[placeholder]`, "coming soon" or "coming in package vN" in visible text. |
| `noindex` | Every page sends `X-Robots-Tag: noindex` and has the robots meta tag. |
| `spec-samples` | Every `<code data-op>` sits in a `<pre>` and names an operation in the spec (no samples: `warn`). |
| `secrets` | Secret patterns in committed files, build output and deployed pages (values never printed). |
| `canary` | No canary string from `--canary-file` anywhere (`skip` without the flag). A failure carries the integrity cap (5.0, decision 0003). |
| `asset-cache` | Every same-origin stylesheet, script, module (including static imports in JS), `@font-face` font and preload that `/` and the crawled pages load either has a content fingerprint in its URL (a hash in the file name, such as `site.3f9a1c2b.css`, or a hash-like `?v=` value) or is served with `Cache-Control: no-cache`, `no-store` or `max-age=0`. An unversioned URL with a positive `max-age`, `immutable`, or no `Cache-Control` fails: a returning visitor keeps the old file under new HTML (a Cloudflare zone's Browser Cache TTL can add hours). Each offender is listed with its URL and cache header. |
| `axe` | axe-core on every page: no critical violations (serious: `warn`). axe is injected through the DevTools protocol, so it runs under a strict CSP (`script-src 'self'`) with the page's CSP still enforced. |
| `signup-flow` | The mock signup reaches its final preview screen, storing and sending nothing. |
| `lighthouse` | Mobile form factor on `/` and every `content:` path, median of 5 runs per route under `~/.greenhouse/perf.lock`. Fails if any route's median performance is below 90, CLS above 0.1 or TBT above 200 ms. Accessibility: 90+ pass, 85-89 `warn`, under 85 fail. |
| `reduced-motion` | With `prefers-reduced-motion: reduce` emulated, scrolling `/` runs no transform or opacity animation longer than 200 ms and no scroll-linked animation, and all content is visible. A failure is the quality cap `motion_ignores_reduced_motion` (7.0). |
| `no-js-content` | With JavaScript disabled, every required content section renders visible text (nothing stuck at opacity 0). |
| `webkit-iphone` | `/` and every `content:` path in Playwright WebKit with the iPhone 15 Pro profile: no page error, no same-origin request that fails or returns 4xx/5xx, no same-origin stylesheet without CSS rules, every non-local `@font-face` loads, no CSP violation blocking a same-origin resource, and the `h1`'s primary font and the body background match Chromium. Host-injected Cloudflare scripts (`static.cloudflareinsights.com`, `/cdn-cgi/`) are ignored. A fold screenshot per route is saved to `<round-dir>/evidence/webkit-iphone/`; `greenhouse capture --round-dir` copies them into the evidence bundle (`webkit-iphone/`, listed in the manifest's `webkit_iphone`), so reviewers see each page as an iPhone renders it. |
| `template-likeness` | Reports nav labels, the heading outline and a similarity score against `template/` and portfolio siblings, as panel evidence. Fails only on near-identity to `template/` (≥ 0.8). Run on `template/` itself it fails by design (similarity 1.0): the template is an unstyled example, not an all-green target. |

Without `--url` the clean build is served locally the way Pages serves it (`_headers` included).
Tool versions (Node, Playwright and its Chromium and WebKit, axe-core, Lighthouse) are pinned in
`package-lock.json` and recorded in `checks.json`.
