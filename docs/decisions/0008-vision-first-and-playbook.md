# 0008: Vision-first sites and the product-site playbook, in scoring, gates and the loop

Date: 2026-11-18. Source: the owner, relayed word for word by VC Joe through the Greenhouse build
lead. Applies to every Greenhouse project, from its next round on.

## Context: the owner's words

> "not only saved to your team memory, let it be part of the scoring, the greenhouse, the RSI. and
> your studies from Mastra shall apply to all upcoming projects instead of only BotRampart."

Two rules the owner set for BotRampart were held in team memory and in one Chief's brief. The owner
decided they are standing rules for every project, and that they must move the score, the gates and
the improvement loop (judge brief, ruling, Chief brief and template: what the owner calls "the RSI"),
so later rounds and projects are judged on them.

## Decision

### Rule 1: vision-first

Package sites are in-house brainstorming that convinces the owner the product will be built like
this. Every feature is shown working. No "coming next", "not available yet", "not yet available",
"not measured yet", "results pending", "until results land", "waiting for results", no progress or
pending cells, and no other framing that waits for results. Benchmarks show confident, full (mock)
results. A small "Sample figures for the private preview" note beside mock figures is required and
enough, and every mock number is listed in the project's `MOCK_FIGURES.md`.

### Rule 2: the product-site playbook (the Mastra study)

Real product screens instead of illustrations; one-word product names and five-word jobs in menus;
the same two calls to action on every page (Get a demo, plus Quickstart or Copy agent prompt);
two-tone headlines (a bold claim plus a grey follow-on); feature cards of a name, a three-word
punchline and one concrete sentence; plain-text docs (`llms.txt` and a `.md` twin of each doc);
solutions pages by buyer that are not thin; a menu and footer that list the same products; no
content hidden until scroll. Source: VC Joe's Mastra teardown (a Reason page in VC Joe's workspace;
not copied into this repository).

### What changes

**Deterministic gates (`greenhouse check`)**

| Gate | Change |
|---|---|
| `product-voice` | **Changed.** Adds the rule-1 forms: coming next; not available yet, not yet available; not measured yet, not yet measured; results pending, result pending, pending results; until results land, until the results land; waiting for results, waiting for the results, awaiting results. Adds pending cells: a table cell whose whole text is pending, in progress, TBD, TBA, measuring, not measured, to be measured, awaiting results or soon. Exempts the exact phrase "Get a demo" (rule 2's call to action) from the `demo` entry; "Book a demo" and every other `demo` use still fail. The decision 0005 list is kept whole. A failure now carries a named quality cap, `hedged_copy` (7.0). |
| `mock-figures` | **New.** Every `data-mock` figure has the sample note beside it (inside it, or in the same `figure`, `table`, `section`, `article` or `aside`), and every number in it is listed for its page in `MOCK_FIGURES.md`; the file must exist when any page marks a figure or shows the note; a page showing the note must mark its figures. |
| `same-ctas` | **New.** Every page carries "Get a demo" and one of "Quickstart" / "Copy agent prompt"; the same second label everywhere; each going to the same place everywhere. |
| `menu-footer-parity` | **New.** Every page has a footer that links to every same-origin page its main menu links to. |
| `no-scroll-reveal` | **New.** With JavaScript on and no scrolling, no text in `<main>` is laid out but invisible (opacity 0, visibility hidden) on `/` or any content path. |
| `docs` | **Kept**; it already checks rule 2's plain-text docs (`llms.txt`, `llms-full.txt`, a Markdown twin of every docs page). |
| `no-js-content` | **Kept**; with `no-scroll-reveal` it covers "no content hidden until scroll". |
| `build`, `package-files`, `claim-links`, `deployed-sha`, `routes`, `links`, `page-structure`, `placeholder`, `noindex`, `spec-samples`, `secrets`, `canary`, `asset-cache`, `axe`, `signup-flow`, `reduced-motion`, `webkit-iphone`, `lighthouse`, `template-likeness` | **Kept unchanged.** |

**Assisted gates (`--assisted`)**

| Gate | Change |
|---|---|
| `claim-sweep` | **Changed.** A sentence whose every number is a sample figure `MOCK_FIGURES.md` lists for its page, on a page with the sample note, is covered by `MOCK_FIGURES.md`: it is not sent to the judges and cannot fail as a claim missing from `claims.yaml`. |
| `claims` | **Kept.** Facts about the outside world in `claims.yaml` are still fetched, quoted and judged. Mock figures do not go in the ledger. |
| `social-proof` | **Kept.** Invented customers, testimonials and logos are not part of this decision; the integrity cap (5.0) is unchanged. |
| `reviewer-instruction`, `hidden-text`, `pricing` | **Kept unchanged.** |

**Scoring: rubric v3** (`rubric/rubric-v3.yaml`, now `CURRENT_RUBRIC_VERSION`)

| Dimension | v2 weight | v3 weight | Change |
|---|---|---|---|
| `design_identity` | 0.20 | 0.20 | Unchanged. |
| `motion_interaction` | 0.15 | 0.10 | Nine adds "nothing hidden until the reader scrolls to it"; "scroll-driven transitions" no longer leads. |
| `copy_voice` | 0.15 | 0.15 | Nine adds rule 1: every feature described as working; conservative or waiting-for-results framing and pending cells score down. |
| `distinctness` | 0.15 | 0.10 | Unchanged text; the menu and buyer-page part of information architecture moves to `product_playbook`. |
| `product_playbook` | - | 0.15 | **New**: rule 2 as craft. A focus dimension (median 8.5 to graduate). |
| `conviction` | 0.10 | 0.10 | Nine adds rule 1: every feature shown working, confident full benchmarks; playing safe scores down. |
| `docs_buildability` | 0.10 | 0.10 | Unchanged. |
| `evidence_truth` | 0.10 | 0.05 | Renamed "Evidence and truthfulness". No longer asks for a real measurement or a sourced, dated vendor comparison for sample grids that carry the note and are listed in `MOCK_FIGURES.md`; drops "at least one locked assumption was tested against real behaviour". Outside facts must still hold against their sources; a figure without the note scores down. |
| `business_signup` | 0.05 | 0.05 | Unchanged. |

Design-led dimensions (design, motion, copy, distinctness, playbook) weigh 0.70 (v2: 0.65). The
weights sum to 1 and the rubric schema is unchanged.

Caps: the quality cap (7.0) adds two named reasons: a failed `product-voice` gate
(`hedged_copy`) and a panel majority setting the new review flag `hedged_vision` (`hedged_vision`).
The quality cap's "unsupported claim" no longer covers sample figures with the note beside them and
listed in `MOCK_FIGURES.md`. The sameness (6.0) and integrity (5.0) caps are unchanged. Graduation
adds `product_playbook` to the focus dimensions.

**The loop ("the RSI")**

- Reviews: the optional flag `hedged_vision`, and an optional `rule` on a finding
  (`vision_first` or `playbook`); a rule-tagged finding must be severity `must` (schema).
- `score.json`: `must_fix` lists every rule-tagged finding, merged across reviewers. Each ruling opens
  with "Must fix next round": every `must_fix` entry, then any failed rule gate (`product-voice`,
  `mock-figures`, `same-ctas`, `menu-footer-parity`, `no-scroll-reveal`, `docs`).
- The Chief brief, the package contract and the design bar carry both rules, so a new Chief builds
  to them from round one. The template models them: "Get a demo" and "Quickstart" on every page, a
  footer listing the menu's pages, and a marked, noted and listed sample benchmark on its comparison
  page with `MOCK_FIGURES.md`.
- The reviewer brief lives in `greenhouse-judge` and is not read or written from this repository
  (decision 0003). It moves to rubric v3 there: the `product_playbook` dimension, the `hedged_vision`
  flag, `rule` tags on findings and the ruling's must-fix section.

### What this supersedes

- **Decision 0005, point 2** ("No invented customers, metrics, testimonials, logos or availability
  ... where a fact cannot be sourced, cut the sentence rather than hedge it"): metrics and
  availability are no longer covered by it. Sample metrics and benchmarks are shown confidently
  under rule 1, with the note and `MOCK_FIGURES.md`, and every feature is shown as available.
  Invented customers, testimonials and logos stay forbidden, and outside facts stay sourced.
- **Decision 0005, point 3**: the list gains the rule-1 forms, and "Get a demo" is exempt from
  `demo`.
- **Rubric v2** for new rounds: `evidence_truth`'s demand for a fair, sourced and dated comparison
  with three or more vendors and a tested locked assumption, as applied to sample grids;
  `motion_interaction`'s lead on scroll-driven transitions; the weights and focus dimensions above.
  v2 stays in `rubric/` so a round already judged on it still scores and renders.
- **Chief brief rule 3** ("No invented ... numbers") and **design bar section 2** ("Label them as
  illustrative", "a crafted illustration"): replaced by rule 1's note and listing, and by real
  product screens.

## Options considered

- **Keep the rules in team memory and the BotRampart brief only.** Rejected by the owner.
- **Score rule 1 only through the panel.** Rejected as the only control: the waiting phrases and
  pending cells are cheap to check exactly, and a gate failure caps the score. The panel flag
  `hedged_vision` covers what a list cannot see (a feature shown greyed out, a benchmark that plays
  safe).
- **Detect mock figures without markup** (every percentage or millisecond on the site). Rejected: it
  cannot tell a sample from a sourced fact or a price, and it would fail every real number.
  `data-mock` plus `MOCK_FIGURES.md` is explicit, and figures without them still go through
  `claim-sweep` and the panel.
- **Fold rule 2 into `distinctness` and `design_identity`.** Rejected: the playbook is a specific
  standard the owner wants scored on its own, and folding it in would let a strong visual identity
  hide a missing call to action or a thin buyer page.
- **A config block for the calls to action** in `greenhouse.yaml`. Rejected: the owner named the
  labels, so the gate checks them directly and Chiefs have nothing extra to declare.
- **Retire v2 as v1 was.** Rejected: the judge and the validation set may still hold v2 reviews,
  and keeping the file costs nothing; new rounds default to v3.

## Evidence

- `npm test` on the Mac mini: each new and changed gate with passing and failing fixtures
  (`cli/test/check-vision.test.ts`; `no-scroll-reveal` in `cli/test/check-browser.test.ts`), rubric
  v3 loading with weights summing to 1, the review and score schema additions, and the
  `hedged_vision` cap and `must_fix` merge in `cli/test/score.test.ts`.
- `greenhouse check` on the template: every gate passes except `template-likeness` (the template is
  the template) and `canary` (skipped without a canary file).
