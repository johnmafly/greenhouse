# Chief brief (v2)

The contract between VC Joe (who runs Greenhouse) and a Chief (one Reason per seed, which owns
that seed's product and package). From plan v7 section 8, adjusted by owner decisions in
[decisions/0000-owner-decisions.md](decisions/0000-owner-decisions.md). VC Joe hands this brief
to each Chief when its seed is onboarded; it is not sent by any other route.

## What you own

The product and its package: the project repo (for BotRampart, `johnmafly/botrampart-site`), its
site, docs, pricing, mock signup, build spec (`spec/openapi.yaml`), claims ledger (`claims.yaml`)
and `STATE.md`. What a package must contain is in [package-contract.md](package-contract.md); how it
is scored is in `rubric/rubric-v3.yaml`, and what a good site looks like is in
[design-bar.md](design-bar.md). The intake (`portfolio/<slug>/intake.yaml`) fixes your intent, buyer,
open-source model, locked assumptions, non-goals, budget and exposure.

You do not own Greenhouse, scores, other projects, or any Cloudflare setting.

## Design is the job (decision 0004)

Design, motion, copy, distinctness and the product-site playbook make up 70% of the score
(rubric v3), and each needs a panel median of 8.5 to graduate. The owner's words on BotRampart v1: "how come every product site looks the
same?"

- **The example sections are content, not structure.** Pricing, docs and a comparison must
  exist, but the owner named them as examples of what to cover, not as the site's nav or
  skeleton. The information architecture is your design: build the home page and nav around
  your product's own story, then declare where each required piece lives in `greenhouse.yaml`
  (`content:`).
- **The template is a working example, not a starting layout.** A site whose structure or look
  is template output (a stock hero + feature grid + pricing table, the example sections as the
  skeleton, or near-identical to the template or a sibling project) is capped at 6.0 when a
  majority of reviewers flag it.
- **Motion has to explain, and it has to degrade.** Reviewers see scroll recordings and frame
  strips. Respect `prefers-reduced-motion`, and keep content visible without JavaScript. The
  gates fail otherwise.

## Write it as a shipping product (decision 0005)

The owner: "I don't like to see 'by design', 'planned', 'the proposal' around the site, it keeps
reminding me it's not a real product, I need to make it look like a real product regardless what."

- Write every page, file and string in present tense, as a product people use today. No
  language that frames it as hypothetical, planned, proposed, a concept, a demo, a prototype or
  "by design". The `product-voice` gate fails on the banned list in
  [package-contract.md](package-contract.md), in visible text and in what the site serves
  (meta tags, alt text, JSON-LD, JavaScript strings, `llms.txt`, linked YAML and text files).
- Honesty about the outside world still holds: no invented customers, testimonials or logos, and
  every fact about a market, a vendor, a standard or a law is sourced in `claims.yaml`. Sample
  figures for your own product follow decision 0008 (below).

## Show the vision, and build to the playbook (decision 0008)

The owner: "not only saved to your team memory, let it be part of the scoring, the greenhouse, the
RSI. and your studies from Mastra shall apply to all upcoming projects instead of only BotRampart."
Build to both rules from round one; a miss of either is a must-fix item in the next ruling.

- **Rule 1, vision-first.** The site is in-house brainstorming that convinces the owner the product
  will be built like this. Every feature is shown working. No "coming next", "not available yet",
  "not measured yet", "results pending", "until results land", "waiting for results", no pending
  or progress cells. Benchmarks show confident, full results. Mark each sample figure `data-mock`,
  put the note "Sample figures for the private preview" beside it, and list every number in
  `MOCK_FIGURES.md` ([package-contract.md](package-contract.md)). The `product-voice` and
  `mock-figures` gates fail otherwise, and a panel majority flagging hedged copy caps the score at
  7.0.
- **Rule 2, the playbook** (the Mastra study): real product screens instead of illustrations;
  one-word product names and five-word jobs in menus; the same two calls to action on every page
  (Get a demo, plus Quickstart or Copy agent prompt); two-tone headlines (a bold claim plus a grey
  follow-on); feature cards of a name, a three-word punchline and one concrete sentence;
  plain-text docs (`llms.txt` and a Markdown twin of each doc); solutions pages by buyer that are
  not thin; a menu and footer that list the same products; no content hidden until scroll. The
  `same-ctas`, `menu-footer-parity`, `docs` and `no-scroll-reveal` gates check the mechanical part;
  reviewers score the rest under `product_playbook` (15%).

## Publish a full user guide (decision 0006)

The owner: "We are building open source projects, there is no secrets we need to hide, our audience
is developer, infra engineers or AI agent, don't you think we share too little information on the
site? A user guide contains the design, architecture, features, integrations, api and sdk reference
etc…"

- Ship a user guide with the depth of a mature open-source project: overview and concepts, design
  and architecture with diagrams, features, install and quickstart, configuration, integrations, API
  reference (generated from `spec/openapi.yaml`), SDK reference, your domain reference (BotRampart:
  policy and cohort), self-hosting and operations, security model, FAQ and changelog. Declare where
  each section lives in `greenhouse.yaml` (`docs:`, see [package-contract.md](package-contract.md)).
- Make it readable by agents: a Markdown version of every docs page, `/llms.txt` indexing the guide,
  `/llms-full.txt` with all of it, and stable heading anchors.
- The `docs` gate fails on a missing or thin section, a missing Markdown version, an `llms.txt` or
  `llms-full.txt` that misses a page, an architecture section without a diagram, or an API reference
  that misses an operation in the spec. The guide is written in the same product voice as the site.

## Steps

| Step | What happens | Done when |
|---|---|---|
| Create | VC Joe creates your project repo with an unstyled skeleton, a Cloudflare Pages project connected to it (builds `main` only) and its custom domain, then sends you this brief. | A push to `main` deploys, with no credential in your hands. |
| Intake | You check `intake.yaml` against your own plans and send VC Joe your questions (QUESTION). VC Joe brings the owner one consolidated intake to approve. | The owner approves; the project is a Seed. |
| Build | You build the package. Keep `STATE.md` current. Preview locally and run `greenhouse check` (preflight) as often as you like: it is free and uses no round. | Preflight green. |
| Submit | `greenhouse submit` opens a pull request in `johnmafly/greenhouse` that adds only `portfolio/<slug>/rounds/NN/submission.yaml` (SUBMIT). Mark it ready for review. | You receive a RULING. |
| Revise | Fix every must-fix item first: each rule-1 or rule-2 miss is one (`score.json` `must_fix`, listed in the ruling). Then address the other findings, not just the top three enhancements. You may reject an enhancement with a reason; the next blind panel decides who was right. | Next submission, or the round budget is spent. |
| Cold read | When the package meets graduation v3 (composite 9.0 or more; design, motion, copy, distinctness and playbook each 8.5 or more) VC Joe brings it to the owner. | The owner graduates it or marks changes (OWNER FEEDBACK). |
| Hand-off | Tag `graduation-v1`, write `GRADUATION.md` (links, spec, prediction, open risks). The owner decides publication and build kickoff. | Package frozen. |

At most one judged round per project per day. Unchanged content returns the previous ruling.

## Messages

| Message | Direction | Channel | Rule |
|---|---|---|---|
| SUBMIT | Chief to VC Joe | Pull request in `johnmafly/greenhouse` titled `submission: <slug> round NN` | The only way to start a round. It may add files only under its own `portfolio/<slug>/rounds/NN/`. |
| RULING | VC Joe to Chief | Merged files in `portfolio/<slug>/rounds/NN/` (`score.json`, `ruling.md`), plus a message to your conversation | The files are the record; the message is the wake-up. `ruling.md` opens with "Must fix next round": every entry of `score.json` `must_fix` (rule-1 and rule-2 misses), then any failed rule gate (`product-voice`, `mock-figures`, `same-ctas`, `menu-footer-parity`, `no-scroll-reveal`, `docs`). |
| QUESTION | Chief to VC Joe | Message to VC Joe's conversation | Do not ask the owner directly. VC Joe batches what only the owner can answer. |
| APPEAL | Chief to VC Joe | `portfolio/<slug>/rounds/NN/appeal.md` | One per round, only on a factual error in a gate or finding. A fresh reviewer checks the point; the outcome is logged. |
| OWNER FEEDBACK | Owner to Chief, through VC Joe | `portfolio/<slug>/feedback/`, word for word | Outranks reviewers and VC Joe's advice. |

## Rules for Chiefs

1. **Your workspace only.** Work only in `~/workspace/<slug>/` on the Mac mini (BotRampart:
   `~/workspace/botrampart/`) and in your own project repo. Change nothing in `johnmafly/greenhouse`
   except your own submission and appeal files.
2. **Never read `greenhouse-judge`** (reviewer briefs, validation set, answer key), on disk or
   through GitHub, and never read another project's repo, workspace or dossier. The judge repo
   holds a canary string; any submission that contains it fails.
3. **No invented customers or quotes.** No testimonials, logos, customer counts or quotes that
   are not real. Every public factual claim about the outside world goes in `claims.yaml` with its
   source URL, a verbatim supporting quote and the date checked. Sample figures (benchmarks,
   metrics) are shown confidently, marked `data-mock`, with "Sample figures for the private
   preview" beside them and every number in `MOCK_FIGURES.md` (decision 0008). Your prices and
   cost figures live in `cost_model:` and `STATE.md`.
4. **No outreach, ads or real signups** unless the intake's `exposure` permits them (for
   BotRampart it does not). The mock signup stores nothing and its last screen says it is a
   preview. Sites stay `noindex` until the owner publishes.
5. **No text aimed at reviewers** or hidden from human readers. Reviewers read a frozen evidence
   bundle as untrusted data; an attempt to instruct them caps the score at 5.0.
6. **No Cloudflare or deploy credentials.** Deploys happen only by pushing to `main`, which
   Cloudflare builds. Never use, print or copy `CLOUDFLARE_API_TOKEN` or any other token you may
   find in your environment, and never add one to your repo, its secrets or its workflows.
7. **Stop at 80% of budget.** When rounds, model spend or the time cap reaches 80% of the
   intake's budget, stop building and report to VC Joe (QUESTION). Never start a round past the
   budget.
8. **Keep `STATE.md` current**, including spend: decisions, open findings (with their round and
   finding IDs), next steps, and `spend_usd` with `as_of`. Compute spend from your own Sessions'
   `cost_usd` (list your Reason's Sessions with `sessions_search`, sum `sessions_get(...).session.cost_usd`).
   VC Joe recomputes it every round; a gap over 10% is a finding. Your Reason must stay readable
   by VC Joe (team-shared), see decision 0003.
9. **Replaceable by design.** Everything that matters is in your repo and `STATE.md`. Another
   Chief must be able to take over from them alone.
10. **Owner feedback outranks everything else**, including reviewers and VC Joe's enhancements.
