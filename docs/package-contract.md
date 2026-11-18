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
| `greenhouse.yaml` | yes | `slug`, `build.command`, `build.output`, `production_branch: main`, the `content:` map, the `cost_model:` and the `docs:` block below. |

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

## Cost model: `cost_model:` in `greenhouse.yaml`

The `pricing` assisted gate reconciles the pricing content with the project's cost model, declared
next to the content map. Only `currency`, `period` and `tiers` (with `name`, `price` and
`cost_to_serve` per tier) are required; the rest is optional, and every key is checked: an unknown
key fails the gate.

```yaml
cost_model:
  currency: USD              # 3-letter code (default USD)
  period: month              # month or year (default month)
  pricing_page: /own/#editions   # where the prices are shown; default content.pricing
  workings: costs/model.mjs  # repo path of the script or sheet that computes the figures
  tiers:                     # every tier on the pricing content
    - name: Community
      price: 0               # per period; null for "contact us"
      cost_to_serve: 0       # what one customer on this tier costs you per period
      edition: Community     # optional text: edition, includes, serves
      kind: self-hosted      # self-hosted or cloud
    - name: Free
      price: 0
      cost_to_serve: 12.39
      below_cost: true       # only a free tier, and only with a reason
      below_cost_reason: "Acquisition: what a free site costs us. Paused at the cap."
      included_sessions: 10000   # any other numeric key is a limit the judges check the page against
      cost_lines: { platform_minimum: 5, shard_duration: 4.15, decision_model: 3.24 }   # must add up to cost_to_serve
    - name: Starter
      price: 49
      price_is_floor: false  # true for a "from" price
      cost_to_serve: 33.57
      margin: 15.43          # optional; must equal price - cost_to_serve
      overage_per_1000: 0.3        # paired with its cost; both null for no overage
      overage_cost_per_1000: 0.02113
  self_hosting:              # optional; implies self_host: true
    path: /build/            # the self-hosting guide; must load
    costs_page: /own/#selfhost   # optional; must load
    price: 0
    cost_to_us: 0
    paid_by: the person running it
    reference_month: { core: 8.03 }   # optional numbers
  sources:                   # where the unit costs come from
    - id: cf-workers-price
      claim: cf-workers-price      # a claims.yaml id, or:
    - id: cf-do-price
      source_url: https://developers.cloudflare.com/durable-objects/platform/pricing/
      quote: "400,000 GB-s / month, + $12.50/million GB-s"
      checked: "2026-11-18"
  assumptions:               # the inputs the figures rest on
    sessions_per_instance: { value: 500000, basis: "site: /build/inside/#core" }
```

`self_host: true` without a `self_hosting` block still works (the pricing content must show the
self-hosting path).

The gate fails when:
- a tier's name or price, or a numeric overage price, is not on the pricing content (only inside
  its `#anchor` when it has one);
- a paid tier, or an overage, sells below its cost to serve. Declaring `below_cost` does not
  excuse a paid tier;
- a free tier (or free self-hosting) costs more than 0 to serve without `below_cost: true` and a
  non-empty `below_cost_reason` (an acquisition cost). With both, it passes, and the gate reports
  it as an acquisition cost;
- `below_cost: true` is set on a tier whose price covers its cost, a stated `margin` is not
  `price - cost_to_serve`, or `cost_lines` do not add up to `cost_to_serve` (half a cent of
  rounding allowed per line);
- the pricing content neither shows nor links to the self-hosting path, or `self_hosting.path` /
  `costs_page` does not load;
- both judges find a contradiction between the pricing text and the cost model.

Amounts on the pricing content that match no tier or overage are listed for the judges and the
panel. The `sources` quotes are checked for shape here, not fetched; ledger facts on the site go
through `claims`.

## User guide: the `docs:` block (decision 0006)

Every package ships a comprehensive user guide for its audience (developers, infra engineers and AI
agents), with the depth an open-source project publishes: nothing about the design is held back.
`greenhouse.yaml` declares where each of the thirteen required sections lives, as a site path with
an optional `#anchor`, or a list of them when a section spans pages:

```yaml
docs:                        # each value: a site path (optionally #anchor), or a list of them
  overview: /docs/           # overview and concepts
  architecture: /docs/architecture/   # design and architecture, with at least one diagram
  features: /docs/features/
  quickstart: /docs/start/   # install and quickstart
  configuration: /docs/configuration/
  integrations: /docs/integrations/
  api_reference: /docs/api/  # every operation in spec/openapi.yaml
  sdk_reference: /docs/sdk/
  domain_reference: [/docs/policy/, /docs/cohorts/]   # the product's own model (BotRampart: policy and cohort)
  self_hosting: /docs/self-hosting/   # self-hosting and operations
  security: /docs/security/  # security model
  faq: /docs/faq/
  changelog: /docs/changelog/
```

| Key | What it must contain | Word floor |
|---|---|---|
| `overview` | What the product is, who it is for, and the concepts the rest of the guide uses. | 150 |
| `architecture` | Design and architecture: components, data flow, trust boundaries, with at least one diagram (`<svg>`, `<img>`, `<picture>`, `<object>` or `role="img"`). | 150 |
| `features` | What the product does, feature by feature. | 150 |
| `quickstart` | Install and quickstart: from nothing to a first result. | 150 |
| `configuration` | Every setting, its default and its effect. | 150 |
| `integrations` | How it connects to the systems its users already run, with code samples tied to the spec. | 150 |
| `api_reference` | Every operation in `spec/openapi.yaml` (generate it from the spec when there is one): method, path, parameters, bodies, responses, errors. | 150 |
| `sdk_reference` | The client libraries or CLI: every public method or command. | 150 |
| `domain_reference` | The product's own model, in full (BotRampart: policy and cohort). | 150 |
| `self_hosting` | Self-hosting and operations: requirements, install, upgrades, backups, monitoring. | 150 |
| `security` | The security model: authentication, authorization, data handling, reporting a vulnerability. | 150 |
| `faq` | Questions a buyer or an engineer asks, answered. | 100 |
| `changelog` | Every release and what it changed. | 40 |

Word floors count the visible words of the section (the page's `<main>`, or the `#anchor`'s
element, without nav, header, footer and aside). The guide may share pages with the `content:` map
(`content.architecture` and `docs.architecture` can be the same page).

**For agents:**

- Every docs page has a Markdown version: `<page>.md` beside it (`/docs/api/` -> `/docs/api.md` or
  `/docs/api/index.md`), or the URL in `<link rel="alternate" type="text/markdown" href>`. It must
  be Markdown, not the HTML page again.
- `/llms.txt` indexes the guide: it links every docs page (its URL or its Markdown URL).
- `/llms-full.txt` is the whole guide in one file: every docs page, under its URL or its title as a
  Markdown heading.
- Headings (`h2`, `h3`) carry stable `id`s, so links into the guide keep working.

The template's `scripts/build.mjs` generates the Markdown versions, `/llms.txt` and
`/llms-full.txt` from the HTML pages; any build that publishes the same files works.

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
- Copy reads as a shipping product, in present tense (`product-voice` gate, decision 0005): no
  framing of the product as hypothetical, planned, proposed, a concept, a demo, a prototype or "by
  design". Honesty still holds: where a fact cannot be sourced, cut the sentence rather than hedge it.
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
| `links` | Every same-origin link, image, script and stylesheet on every reachable page resolves. URLs Cloudflare writes into served pages under `/cdn-cgi/` (email obfuscation's `/cdn-cgi/l/email-protection`) are the host's and are listed as ignored. |
| `page-structure` | Every page has `lang`, a `<title>` and exactly one `<h1>`. |
| `placeholder` | No `lorem`, `TODO`, `TBD`, `[placeholder]`, "coming soon" or "coming in package vN" in visible text. |
| `product-voice` | None of the decision 0005 banned list (by design, in design, planned, plan to / plans to / planning to, propose / proposes / proposed / proposing / proposal / proposals, hypothetical, concept, demo / demos, mockup / mockups / mock-up / mock-ups, prototype / prototypes, roadmap, coming soon, not (yet) built, not for sale, nothing is for sale, for sale yet, illustrative, not a real, first build, come(s) later, ship(s) later, architecture plan, placeholder copy), case-insensitive, whole words only (a "Concepts" heading, "value proposition" and "demonstrate" pass), in the visible text of any page or the 404 page, `<title>`, `<meta content>`, `alt` / `title` / `aria-label` / `aria-description` / `placeholder` attributes, JSON-LD, JavaScript string literals (inline and served, imports followed), `/llms.txt`, `/llms-full.txt` or any linked same-origin `.txt` / `.yaml` / `.md` file. HTML comments are not read. Each hit is listed with its page or file, location and a snippet. |
| `docs` | The user guide (decision 0006): `greenhouse.yaml` has a `docs:` block with all thirteen sections; each section's pages return HTML with status 200, every `#anchor` exists, and each section meets its word floor; the architecture section has a diagram; with a `spec/openapi.yaml`, the API reference names every operation (its `operationId` or its path); every docs page has a Markdown version; `/llms.txt` lists every docs page and `/llms-full.txt` carries every docs page. Headings without an `id` warn. |
| `noindex` | Every page sends `X-Robots-Tag: noindex` and has the robots meta tag. |
| `spec-samples` | Every `<code data-op>` sits in a `<pre>` and names an operation in the spec (no samples: `warn`). |
| `secrets` | Secret patterns in committed files, build output and deployed pages (values never printed). |
| `canary` | No canary string from `--canary-file` anywhere (`skip` without the flag). A failure carries the integrity cap (5.0, decision 0003). |
| `asset-cache` | Every same-origin stylesheet, script, module (including static imports in JS), `@font-face` font and preload that `/` and the crawled pages load either has a content fingerprint in its URL (a hash in the file name, such as `site.3f9a1c2b.css`, or a hash-like `?v=` value) or is served with `Cache-Control: no-cache`, `no-store` or `max-age=0`. An unversioned URL with a positive `max-age`, `immutable`, or no `Cache-Control` fails: a returning visitor keeps the old file under new HTML (a Cloudflare zone's Browser Cache TTL can add hours). Each offender is listed with its URL and cache header. Scripts Cloudflare injects under `/cdn-cgi/` (email obfuscation, Web Analytics) are the host's, not the package's: they are listed as ignored, as in `webkit-iphone`. |
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

## Assisted gates: `greenhouse check --assisted`

`greenhouse check --assisted --judge <id>=<family>:<command> --judge <id>=<family>:<command>
[--archive-dir <dir>]` adds six assisted gates (`class: "assisted"` in `checks.json`) after the
deterministic ones. Each does a mechanical proof first and asks two model judges from different
families only what the mechanics cannot settle. A judge is a command that reads a request
(`{"schema": "greenhouse-judge-request/1", "task", "question", "material"}`) on stdin and writes
`{"answer": "yes" | "no" | "unclear", "reason": "..."}` on stdout; the judge runner supplies the
model adapters, and the tests use stub judges, so this repository makes no model calls.

A problem the mechanics prove fails on its own. A candidate only the judges can settle fails when
both judges agree it is a problem and warns when they split (disagree, `unclear` or an error), so
the panel sees it. A claim passes only when both judges say its quote supports it.

| Gate | Mechanical proof | Judges | Cap on failure |
|---|---|---|---|
| `claims` | Every `source_url` fetched with a browser User-Agent (429 retried once) and archived under `--archive-dir` (default `<round-dir>/sources/`, else `~/.greenhouse/archive/<slug>-<sha12>/`: one file per body, named by its sha256, plus `index.json`). The `quote` must be in the source verbatim (up to whitespace, spacing around punctuation, quote marks, dashes and case; `...` marks an omission); pages that need JavaScript are rendered in the browser. A source that answers with a bot challenge (Imperva, Cloudflare, DataDome, HUMAN, AWS WAF or Akamai) instead of its content counts as refused automation, as a 403 does: `warn` when the claim was checked within 30 days, else fail. | Does the quote support the claim exactly as written? | `unsupported_claim` (7.0) |
| `claim-sweep` | Sentences on every page with a figure, a comparison, a superlative or research, not covered by a ledger claim. | Is this a claim about the outside world that needs a public source? | failed gate (7.0) |
| `pricing` | Tiers, prices, overages, cost to serve (a free tier below cost only with `below_cost_reason`) and the self-hosting path against `cost_model:` (above). | Does the pricing text contradict the cost model? | failed gate (7.0) |
| `social-proof` | Testimonials, attributions, logo walls, customer counts, ratings and press mentions not backed by the ledger. | Is this presented as real social proof for this product? | `invented_social_proof` (5.0) |
| `reviewer-instruction` | Pages, `/llms.txt`, `/robots.txt` and similar files: instructions to models or reviewers in comments, attributes, scripts or hidden text fail outright; the same words in visible text, or text that mentions reviewers or models, go to the judges. | Is this addressed to an AI reviewer or judge rather than to visitors? | `reviewer_instruction` (5.0) |
| `hidden-text` | Start pages fetched as a browser and as Googlebot, GPTBot and ClaudeBot: different content fails (cloaking). In the browser, text laid out but invisible (off-screen, clipped, tiny or same colour as its background); clipped or off-screen labels up to 80 characters are screen-reader text and allowed. | Is this hidden text there for machines rather than people? | failed gate (7.0) |

`template-likeness` also measures the home page's first screen (1440x900, reduced motion) against
`template/` and the `--sibling` projects: the mean of a 64-bin colour-histogram intersection and a
32x20 luminance-grid correlation. It is panel evidence and warns at 0.9 or more; the gate still
fails only on structural near-identity to `template/`. Without a browser it records why it has no
visual measure.
