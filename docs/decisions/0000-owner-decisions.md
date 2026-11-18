# 0000: Owner decisions at plan approval (2026-11-18)

The owner (johnmafly) approved plan v7 with these changes and confirmations:

1. **Exposure: public by default.** Project sites are public so the owner can invite partners
   to give feedback. This replaces v7's "private behind Cloudflare Access by default".
   Sites still send `noindex` until the owner publishes at graduation. Access stays available
   per project if an intake asks for it.
2. **Cloudflare:** full permission on the owner's existing Cloudflare account; the API token is the
   Reason secret `CLOUDFLARE_API_TOKEN` (account-scoped). The Cloudflare GitHub app is installed.
   `workers.dev` / `pages.dev` addresses are used, and `agenthatch.ai` subdomains when useful.
   This replaces v7's "dedicated Cloudflare account" (section 11): the token's blast radius is the
   whole account, so it stays only in the judge's environment, never with Chiefs.
3. **Delivery:** work is tracked as GitHub issues, delivered as pull requests, built by parallel
   Reason Sessions on the Mac mini (agenthatchminisg) only, never Reason cloud.
4. **First seed:** BotRampart (its Reason is the Chief). Its architecture plan is the intake source.
5. **Repos:** `johnmafly/greenhouse` (public) and `johnmafly/greenhouse-judge` (private).
