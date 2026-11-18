# 0004: Design bar v2: design, motion, copy and distinctness lead the score

Date: 2026-11-18. Source: owner feedback on BotRampart v1 (`7612a2a`), relayed word for word by
VC Joe, and VC Joe's design-bar v2 spec of the same day. Replaces rubric v1 and package contract v1.

## Context: the owner's words

> "The site is look so ugly, like born last era, the wording is not attractive to me, no design, no page
> effects, no animations, no transitions during scrolling, and the site structure exactly follows what I
> mentioned (pricing, docs, compare), I just give my example, how come every product site looks the same?
> Think deeply and adjust your scoring accordingly, you can study some reference sites if needed."

Rubric v1 gave design ("site craft") 15% and distinctness 10%, and package contract v1 fixed nine
routes, including `/pricing/`, `/docs/comparison/` and the other `/docs/*` pages. A package could
reach a high composite as a well-typeset document whose structure was the owner's example list.
That is what BotRampart v1 is. The owner's examples (pricing, docs, compare) were content to cover,
not a skeleton to copy.

## What the reference sites do

VC Joe studied them on 2026-11-18 on the Mac mini, in Chromium at 1440x900, scrolling in 700 px steps.
Measured with `document.getAnimations()` while scrolling, and by scanning CSS rules for
`prefers-reduced-motion` and scroll or view timelines:

| Site | Page height (px) | Distinct animations | Peak running | Peak with reduced motion | reduced-motion rules | Scroll/view timelines | Type |
|---|---|---|---|---|---|---|---|
| linear.app | 9,990 | 81 | 522 | 100 | 52 | yes | Inter Variable + Berkeley Mono |
| raycast.com | 15,969 | 9 | 27 | 18 | 13 | no (JS-driven) | Inter + Instrument Serif + mono |
| stripe.com | 14,846 | 13 | 66 | 39 | 0 (handled in JS) | no | Sohne (licensed) + Source Code Pro |
| vercel.com | 5,333 | 0 idle (canvas/WebGL hero) | 0 | 0 | 21 | yes | Geist family incl. pixel display cuts |
| framer.com | 12,346 | 2 | 7 | 7 | 0 | yes | mixed display families |
| botrampart v1 (`7612a2a`) | 6,580 | 3 | 4 | 0 | 1 | no | system fallbacks only |

What sets them apart:

1. **Visual identity is a system, not a palette.** Each owns a type pairing (often a licensed or
   custom family), a signature colour or light treatment (Linear's dark gradients and hairlines,
   Raycast's glowing keyboard and per-extension colour fields, Stripe's animated gradient wave,
   Vercel's geometric and pixel display cuts) and a recurring motif. You can tell the site from a
   cropped screenshot with the logo hidden.
2. **The product is the hero.** Real, live-looking UI (Linear's roadmap and cycle-time chart,
   Raycast's command bar and extension cards, Stripe's payment form and billing meter) rendered as
   crafted illustrations, not a feature grid of icons.
3. **Motion carries the story.** Scroll-linked reveals, pinned sections that step through a
   process, UI that animates into its next state, micro-interactions on hover and focus. Motion
   explains (a request flowing, a budget draining); it is not decoration. Linear runs hundreds of
   animations yet cuts them by about 80% under reduced motion.
4. **Copy has a voice.** Short, confident lines with a point of view: "Your shortcut to
   everything." / "It's not about saving time. It's about feeling like you're never wasting it."
   (Raycast). Headlines are claims a competitor could not paste onto its own site; body copy is
   specific.
5. **Structure follows the product's story.** The home page is a narrative designed for this
   product (Raycast: keyboard, extensions, AI, store; Linear: plan, build, monitor). Nav items are
   the product's own nouns (Store, Pro, Now, Customers); pricing and docs exist but are not the
   skeleton.
6. **Craft details:** rhythm and generous spacing, depth (light, blur, grain, glow), layouts
   redesigned for the phone rather than stacked, fast first paint despite motion.

BotRampart v1 is clean and honest but reads as a well-typeset document: a cream page, a serif
headline, outline buttons, a nav of exactly How it works / Docs / Compare / Pricing (the owner's
examples plus the template's), sections numbered "05 · WHO IT IS FOR", no motion beyond one
widget, no imagery, no light or depth.

No third-party screenshots are kept in this repository; the table and notes above are the record.
[design-bar.md](../design-bar.md) turns these findings into guidance for Chiefs.

## Decision

### 1. Rubric v2 replaces v1

`rubric/rubric-v2.yaml`. The scale and anchors are unchanged. The design-led dimensions go from
0.25 of the weight to 0.65:

| id | name | weight |
|---|---|---|
| `design_identity` | Visual design and identity | 0.20 |
| `motion_interaction` | Motion and interaction | 0.15 |
| `copy_voice` | Copy and voice | 0.15 |
| `distinctness` | Distinctness and information architecture | 0.15 |
| `conviction` | Conviction | 0.10 |
| `docs_buildability` | Docs and buildability | 0.10 |
| `evidence_truth` | Evidence, truthfulness and comparison honesty (merges v1 `comparison_honesty`) | 0.10 |
| `business_signup` | Business model and first value (merges v1 `pricing_oss` and `signup_value`) | 0.05 |

Each dimension's "nine" text is in the rubric file.

**Caps.** The existing quality (7.0) and integrity (5.0) caps stay. Two additions:

- A new **sameness** cap, max **6.0**, reason `template_sameness`: a strict majority of the panel
  (2 of 3, 3 of 4) sets the new review flag `template_structure`. A reviewer sets it when the
  site's structure or look is template output: a stock hero + feature grid + pricing table, the
  owner's example sections used as the fixed skeleton, or near-identical to the template or a
  portfolio sibling. One reviewer alone does not cap; that reviewer's scores already say it.
- A failed `reduced-motion` gate is a named quality cap (reason `motion_ignores_reduced_motion`, 7.0).

**Graduation v2:** composite ≥ 9.0; every dimension median ≥ 8.0; the medians of
`design_identity`, `motion_interaction`, `copy_voice` and `distinctness` ≥ **8.5**
(`graduation.focus_dimensions` / `focus_median_min`); every reviewer composite ≥ 8.5; gates green
on the submitted SHA; then the owner's cold read.

**v1 is retired, not kept beside v2.** No round was scored on v1, so there is nothing to
re-score and no history to render. `rubric/rubric-v1.yaml` is removed (it stays in git history),
the loader's default is v2 (`CURRENT_RUBRIC_VERSION`), and a review that says `rubric_version: 1`
cannot be scored. Test fixtures were moved to v2 ids.

### 2. Package contract v2: required content, not required routes

Only `/`, `/.well-known/greenhouse.json` and a 404 page are fixed. The Chief designs the site's
information architecture and declares in `greenhouse.yaml` where each required piece of content
lives (`content:` with `how_it_works`, `getting_started`, `architecture`, `integration`,
`comparison`, `pricing`, `signup`). The template keeps working routes as an unstyled example and
says so. The Chief brief says the owner's example sections are content, not a structure to copy.
See [package-contract.md](../package-contract.md).

### 3. Reviewers see motion

Stills cannot show motion. `greenhouse capture` adds, for the home page and the signup start at
desktop 1440x900 and phone 390x844, a scroll recording (webm) and a 12-frame strip PNG (for
reviewer models that read images but not video), plus one reduced-motion strip of the home page.
All of them are hashed into the evidence bundle. The reviewer brief (greenhouse-judge) gets v2
guidance for the four design dimensions and the `template_structure` flag.

## Motion guardrails

More motion must not cost accessibility, content or speed. Deterministic gates in `greenhouse check`:

- **`reduced-motion`**: with `prefers-reduced-motion: reduce` emulated, scrolling the home page runs
  no transform or opacity animation longer than 200 ms and no scroll-linked animation, and all
  content is visible. Fail otherwise (quality cap, `motion_ignores_reduced_motion`).
- **`no-js-content`**: with JavaScript disabled, every required content section renders visible
  text (no scroll-reveal content stuck at opacity 0). Fail otherwise.
- **`lighthouse`** (exists): mobile performance ≥ 90, CLS ≤ 0.1, TBT ≤ 200 ms on every route,
  median of 5 runs.
- **`template-likeness`**: reports nav labels, the heading outline and a similarity score against
  `template/` and portfolio siblings into `checks.json` as panel evidence. It fails only on
  near-identity to `template/` (≥ 0.8); sameness otherwise is the panel's call through
  `template_structure`.

Side item decided with this record: `signup-flow` ignores Cloudflare's same-origin
`POST /cdn-cgi/rum` (the Web Analytics beacon) and still fails on any other non-GET request.

## Consequences

- BotRampart v1 is the case this record was written for. Its Chief redesigns before its first
  judged round, and the judge's dry run waits for that redesign, so no panel money is spent on v1.
- Scores are not comparable across rubric versions. The board labels each round with its
  rubric version.
- Implementation is split: this record, the rubric, schemas, scoring, capture and docs land in one
  pull request; the `greenhouse check` side (content-map validation and the `reduced-motion`,
  `no-js-content` and `template-likeness` gates) follows in a second one that rebases on it.
