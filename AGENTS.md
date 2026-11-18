# Working in this repo (for Reason Sessions and Chiefs)

- One issue, one branch, one pull request. Reference the issue with `Fixes #N`.
- Node 24+, ESM, TypeScript via native type stripping: use only erasable syntax
  (no `enum`, no `namespace`, no parameter properties). Import with explicit `.ts` extensions.
- Tests: `node --test` files under `**/test/*.test.ts`. `npm test` must pass before you open a PR.
- Keep dependencies few and pinned (`package-lock.json` committed).
- Never commit secrets. The Cloudflare token is only ever read from the environment
  (`CLOUDFLARE_API_TOKEN`) by the judge; never echo it, never write it to a file.
- Never read or copy anything from `greenhouse-judge` into this repo.
- Other Sessions work in this repo at the same time on other issues: do not reformat or
  rewrite files outside your issue's scope; rebase on `main` before opening the PR.
- Decision records go in `docs/decisions/NNNN-title.md` (context, options, decision, evidence).
