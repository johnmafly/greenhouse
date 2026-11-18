# 0006: Every project ships a comprehensive user guide

Date: 2026-11-18. Source: the owner, relayed word for word by VC Joe. Applies to every Greenhouse
project.

## Context: the owner's words

> "We are building open source projects, there is no secrets we need to hide, our audience is
> developer, infra engineers or AI agent, don't you think we share too little information on the
> site? A user guide contains the design, architecture, features, integrations, api and sdk
> reference etc…"

Package contract v2 required four pieces of documentation (how it works, getting started,
architecture, integration) and checked only that their pages loaded. Sites shipped a page or two of
docs, and nothing gave agents a machine-readable copy.

## Decision

1. **Every package ships a user guide** with thirteen sections: overview and concepts; design and
   architecture, with diagrams; features; install and quickstart; configuration; integrations; API
   reference (generated from `spec/openapi.yaml` when the project has one); SDK reference; domain
   reference (BotRampart: policy and cohort); self-hosting and operations; security model; FAQ;
   changelog. It is written in product voice (decision 0005).
2. **Agent-friendly output.** A Markdown version of every docs page, `/llms.txt` indexing the
   guide, `/llms-full.txt` with all of it, and stable heading anchors.
3. **A package declares where each section lives** in a `docs:` block in `greenhouse.yaml`
   (section key -> site path with an optional `#anchor`, or a list of them), like the `content:`
   map. The information architecture stays the Chief's design.
4. **A mechanical gate checks it.** `docs` in `greenhouse check` fails when the block is missing or
   names an unknown section; a section's page does not load or its anchor is missing; a section is
   under its word floor (150 words; FAQ 100; changelog 40); the architecture section has no
   diagram; with a `spec/openapi.yaml`, the API reference misses an operation (by `operationId` or
   path); a docs page has no Markdown version; or `/llms.txt` / `/llms-full.txt` is missing or
   misses a docs page. Headings without an `id` warn. A failed gate is a failed deterministic gate
   (quality cap, 7.0).
5. **The rubric scores depth.** The `docs_buildability` dimension (weight 0.10, renamed "Docs depth
   and buildability") now asks for the full guide, and a thin or partial guide scores down even when
   the gate passes. The id is unchanged, so earlier scores and the judge's score schema stay valid.
6. **The template models it.** Its guide has all thirteen sections in product voice, and its
   `scripts/build.mjs` generates the Markdown versions, `/llms.txt` and `/llms-full.txt`. The
   template passes the gate itself.

## Options considered

- A new rubric dimension (`docs_depth`) next to `docs_buildability`. Rejected: two overlapping
  dimensions split one judgement, and a new id changes the score schema, every review and the
  judge's brief. Widening the existing dimension keeps one place for docs.
- Raising the docs weight. Not done: decision 0004's weights (design-led dimensions at 0.65) are the
  owner's; this rule changes what the docs dimension asks for, not its weight.
- Judging docs depth only by reviewers. Rejected as the only control: whether a section, a Markdown
  copy or an API operation exists is cheap to check exactly, and reviewers then judge quality.
- Requiring fixed URLs (`/docs/api/` and so on). Rejected for the same reason as decision 0004's
  content map: the site's structure is the Chief's design.

## Evidence

- `npm test` on the Mac mini: the gate's passing and failing fixtures (the template passing; a
  missing block; a missing or unknown key; a section page gone; a thin section; a missing and a
  present anchor; an architecture page without a diagram; an API reference missing an operation; a
  package without an OpenAPI spec; a missing Markdown version and an HTML page served as `.md`;
  `/llms.txt` and `/llms-full.txt` missing or missing a page; a heading without an id warning).
- The gate against live BotRampart's guide (botrampart-site#14), with a `docs:` block mapped to its
  pages: all thirteen sections over their floors, thirteen Markdown versions, both llms files
  complete, all 14 API operations documented.
