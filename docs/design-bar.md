# Design bar (v2)

What "good" looks like for a Greenhouse introduction site, for Chiefs. It is drawn from the
reference sites VC Joe studied for [decision 0004](decisions/0004-design-bar-v2.md) (Linear, Raycast,
Stripe, Vercel, Framer); the measurements are in that record. The rubric
([rubric-v2.yaml](../rubric/rubric-v2.yaml)) is what reviewers score. This page explains how to get there.

Four of the eight dimensions are about design and together weigh 65%: visual design and identity
(20%), motion and interaction (15%), copy and voice (15%), and distinctness and information
architecture (15%). To graduate, each of the four needs a panel median of at least 8.5.

## 1. Build an identity system, not a palette

- Choose a type pairing that belongs to this product: a display face with character plus a text
  face, and a mono if the product is technical. System fallbacks alone read as "no design".
  Self-host fonts whose licence allows it.
- Choose a signature light or colour treatment (gradients, glow, hairlines, grain, a single
  saturated accent on a deep ground) and use it everywhere.
- Choose one recurring motif that comes from the product: a shape, a diagram language, a texture.
- Test: hide the logo and crop any section. Could it be anyone else's site? If yes, keep going.
- Design the phone layout on purpose. Re-compose sections for 390 px instead of stacking the
  desktop columns.

## 2. Make the product the hero

- Show the product working: its console, its decision log, a request moving through it, rendered
  as a crafted illustration (HTML/CSS/SVG or canvas). A grid of feature icons is not a hero.
- Use real-looking states and numbers that follow from your own design. Label them as
  illustrative. Never present invented customers or metrics as real (integrity cap).

## 3. Let motion explain

- Use scroll-linked reveals, pinned sections that step through a process, and UI that animates
  into its next state. Each animation should explain something, for example a budget draining, a
  challenge escalating, or a decision being cached. Add micro-interactions on hover and focus.
- Keep it smooth: animate `transform` and `opacity`, not layout. Mobile Lighthouse performance must
  stay at 90 or above, CLS at 0.1 or below and TBT at 200 ms or below.
- **Respect `prefers-reduced-motion`.** Under reduce, no transform or opacity animation runs longer
  than 200 ms, nothing is scroll-linked, and every piece of content is visible. The meaning must
  survive without the motion: swap the animation for a static diagram, not for nothing. The
  `reduced-motion` gate fails otherwise, and that caps the score at 7.0.
- **Nothing is hidden without JavaScript.** Content that fades in on scroll must be visible when JS
  is off: start it visible and let JS opt it into the animation. The `no-js-content` gate checks this.
- Reviewers see a scroll recording and 12-frame strips of `/` and of your signup start, on desktop
  and phone, plus a reduced-motion strip, and the first screen of every page as Safari on an iPhone
  renders it (WebKit). Design the scroll, not just the first screen.

## 4. Write with a voice

- Headlines are claims a competitor could not paste onto its own site. Short, confident and specific.
- Cut generic SaaS phrasing such as "powerful", "seamless", "all-in-one", "take control", "built
  for scale" and "next-generation".
- Body copy says something concrete: a number, a mechanism, a trade-off you made.
- A reader should want to keep scrolling. Read the page aloud; if a line sounds like a template, it is.

## 5. Design the structure around the product's story

- The owner's examples (pricing, docs, compare) are **content to cover**, not the site's skeleton.
  A nav that reads exactly How it works / Docs / Compare / Pricing is the template, and reviewers
  flag it.
- Find the product's own story and build the home page as that narrative. Use the product's own
  nouns in the nav.
- Put the required content wherever your structure needs it, and declare where in
  `greenhouse.yaml` (`content:`; see [package-contract.md](package-contract.md)). Pages may share a
  path through anchors.
- Avoid the stock layout of hero + three-column feature grid + pricing table + FAQ + footer CTA.
  Avoid looking like the template or a sibling project.

## How sameness is judged

Every reviewer answers one yes/no question, the `template_structure` flag: is this site's
structure or look template output? That covers a stock hero + feature grid + pricing table, the
owner's example sections used as the fixed skeleton, or near-identity to `template/` or a
portfolio sibling. If a majority of the panel says yes, the composite is capped at **6.0**,
however good each part is. The `template-likeness` gate gives reviewers the nav labels, heading
outline and similarity scores, and fails outright only on near-identity to `template/`.

## Checklist before you submit

- [ ] Logo-less crop test passes on three random sections, desktop and phone.
- [ ] The hero shows the product working, not an icon grid.
- [ ] Every animation explains something; reduced motion shows the same meaning, statically.
- [ ] With JS off, every required content section shows its text.
- [ ] Mobile Lighthouse ≥ 90, CLS ≤ 0.1 and TBT ≤ 200 ms on every page you declare.
- [ ] No generic SaaS lines; every headline is specific to this product.
- [ ] The nav and home page follow this product's story, and every `content:` key resolves.
