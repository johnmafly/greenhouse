# 0007: BotRampart product direction: detection core, integration options, economics add-on

Date: 2026-11-18. Source: the owner, relayed word for word by VC Joe as feedback on the BotRampart
site. Applies to the BotRampart intake ([portfolio/botrampart/intake.yaml](../../portfolio/botrampart/intake.yaml)).

## Context: the owner's words

> "people anxiety about the growing threats by AI bots and browser automations. that is where we can
> stand out"

> "the chief put too much contents introducing 'request economics' concept on home page, however, its
> just a addon feature for botrampart, not the core"

> "I hope everyone can enjoy our product even if they dont want to touch their code, datadome offer so
> many integration options, people can choose sdk, nginx module, cloudfront worker or cloudflare
> worker, etc."

> "the intro contents never mention about our bot detection, it is actually one of our core feature,
> we collect risk signals from browser, abnormal ui behaviors ... (we will develop the bot detection
> benchmark as our selling point, imagine x-axis is the list of popular bot/automation tools, y-axis
> is the list of bot management vendors)"

> "the contents never explain our autopilot multi-tier challenging, custom polices"

> "the sdk itself shall not store the aggregated visitor metrics, because it will affect the app's
> performance, sdk must be lightweight"

> "security specialist ai agent shall be one of our selling point where other vendor dont have"

> "the site is missing sign up, sign in and dashboard (with demo data)"

The intake, drafted from the architecture plan, made request economics the core, limited
enforcement to SDKs, ruled out autopilot, and did not name bot detection or the agent as selling
points.

## Options

1. Leave the intake and let the Chief adjust site copy only. Rejected: the judge and the Chief read
   the intake as the source of truth, so the old core would keep coming back.
2. Update the intake to the owner's direction. Chosen.

## Decision

The BotRampart intake changes as follows (each changed locked assumption is marked
"(owner direction, 2026-11-18)"):

1. **Core:** bot detection from browser risk signals and abnormal UI behaviour, autopilot multi-tier
   challenges, custom policies and the security-specialist AI agent. Request economics is an add-on.
2. **Integration:** inside the customer's own app or infrastructure with no vendor proxy: the Node SDK
   first, with an nginx module, a Cloudflare Worker and CloudFront (Lambda@Edge) in the customer's
   own account as further options. The adapters stay non-goals for the first build and are shown as
   not available yet.
3. **Autopilot:** challenges escalate automatically by tier; policy is a file of custom rules with
   good defaults; the decision model stays in shadow mode and never acts live in the first build.
4. **Lightweight SDK:** the backend SDK keeps no aggregated visitor metrics; Core aggregates.
5. **Benchmark:** published bot-detection results (vendor x automation-tool grid) are a non-goal; the
   site shows the grid's design with no results.
6. **Accounts:** sign-up, sign-in and a dashboard with sample data are a client-side preview;
   `exposure.real_signups` stays false.

Budget, exposure and `approved_by_owner` are unchanged.

## Evidence

- `node cli/src/main.ts validate portfolio/botrampart/intake.yaml` passes on the updated intake.
- `npm test` passes.
