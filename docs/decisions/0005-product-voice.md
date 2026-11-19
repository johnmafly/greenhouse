# 0005: Product voice: every site reads as a shipping product

Date: 2026-11-18. Source: the owner, relayed word for word by VC Joe. Applies to every Greenhouse
project.

> Amended by [0008](0008-vision-first-and-playbook.md): point 2 no longer covers metrics or
> availability (sample figures are shown with a note and listed in `MOCK_FIGURES.md`, and every
> feature is shown working); point 3's list gains the rule-1 forms, and "Get a demo" is exempt.

## Context: the owner's words

> "I don't like to see 'by design', 'planned', 'the proposal' around the site, it keeps reminding me
> it's not a real product, I need to make it look like a real product regardless what."

Package sites carried hedges that framed the product as hypothetical: the template's own footer said
"Example Seed is a Greenhouse seed: a preview of a product that is not built yet.", and Chiefs
copied that framing ("planned", "by design", "the proposal", "first build").

## Decision

1. **Copy is written in present tense, as a shipping product.** No language that frames the product
   as hypothetical, planned, proposed, a concept, a demo, a prototype or "by design".
2. **Honesty still holds.** No invented customers, metrics, testimonials, logos or availability
   (the `social-proof` and `claims` gates and the claims ledger are unchanged). Where a fact cannot be
   sourced, cut the sentence rather than hedge it.
3. **A mechanical gate enforces the banned list.** `product-voice` in `greenhouse check` fails on any
   of these forms, case-insensitive, on word boundaries: by design; in design; planned; plan to,
   plans to, planning to; propose, proposes, proposed, proposing, proposal, proposals;
   hypothetical(ly); concept; demo, demos; mockup, mockups, mock-up, mock-ups; prototype, prototypes,
   prototyped, prototyping; roadmap(s); coming soon; not built, not yet built; not for sale; nothing
   is for sale; for sale yet; illustrative(ly); not a real; first build; come later, comes later;
   ship later, ships later; architecture plan(s); placeholder copy. Whole words only, so a
   "Concepts" docs heading, "value proposition" and "demonstrate" pass.
   It reads everything a person or an agent can meet: the visible text of every crawled page and the
   404 page, `<title>`, every `<meta content>` (description, Open Graph, Twitter), `alt`, `title`,
   `aria-label`, `aria-description` and `placeholder` attributes, JSON-LD, string literals in inline
   and served JavaScript (following imports), `/llms.txt`, `/llms-full.txt`, and every same-origin
   `.txt`, `.yaml`/`.yml` and `.md` file a page links to. HTML comments are not read (no reader sees
   them; the `reviewer-instruction` gate covers them). Each hit is reported with its page or file,
   where in it, the pattern and a snippet.
4. **The template models the rule.** Its "preview of a product that is not built yet" footer is gone
   from every page.
5. **The rubric's copy criterion scores hedged or hypothetical framing down.**

## Options considered

- A judge-only rule (reviewers mark hedged copy down). Rejected as the only control: the owner wants
  the words gone, and a list is cheap to check exactly.
- A broader list (every "plan", "design"). Rejected: "the Team plan", "Designed for platform teams"
  and "value proposition" are shipping-product copy; word boundaries keep the list to what the owner
  named.

## Evidence

- `npm test` on the Mac mini: the gate's passing and failing fixtures (visible text, the 404 page, a
  hit only in `alt`, only in meta, only in served JS behind an import, JSON-LD, `aria-label`, inline
  JS, `llms.txt`, a linked YAML file; near misses that must pass) and the template passing.
