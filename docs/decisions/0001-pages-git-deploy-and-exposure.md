# 0001: Pages deploys from GitHub, and public + noindex exposure (P0-A spike)

Issue: #1. Date: 2026-11-18. Plan v7 assumptions 2 and 3 (sections 9, 11, 14), adjusted by
owner decision 0000-1 (project sites are **public by default**, `noindex` until published).

Status (updated 2026-11-18, follow-up to #1): **native Pages Git integration is in force.**
The GitHub Actions direct-upload fallback ran for one day of merges and is retired (section 6).

## Summary

| Point | Answer | In force |
|---|---|---|
| Pages project connected to this repo through the Cloudflare GitHub app | **Yes**, since the owner connected `johnmafly` (connection `provider_account_id` 32551433, created 2026-11-18T09:53Z). At first this was blocked: the only connection was `agenthatch-ai`, and the API returned `8000011` (section 1). | **Native Git:** `greenhouse-board` builds `main` on Cloudflare (section 6). |
| Push to `main` deploys with no token held by a Chief | **Yes.** Cloudflare builds from GitHub itself; no deploy token exists in the repo or with anyone else. The Actions fallback (section 2) is retired: workflow deleted, repo secrets deleted, Pages-only token deleted. | Native Git, production branch `main`, no preview deployments. |
| Custom domain `greenhouse.agenthatch.ai` | **Yes.** Attached to the Git-connected `greenhouse-board`, proxied CNAME to `greenhouse-board.pages.dev`, serves 200. | Live. |
| `_headers` sends `X-Robots-Tag: noindex` on Pages | **Yes**, on both `pages.dev` and the custom domain. | `board/public/_headers`, guarded by `board/test/headers.test.ts`. |
| Publicly reachable without Access | **Yes.** No Access application covers either hostname. | Owner decision 0000-1. |
| Free-plan limits that matter | Recorded below. | |

## Context

v7 assumed a Pages project connected to each repo by Cloudflare's Git integration, so
deploys happen on push with no credential held by anyone but Cloudflare. The owner said the
Cloudflare GitHub app is installed and that sites are public by default but `noindex`.

## Evidence

All calls ran on the Mac mini (agenthatchminisg) with the account-scoped `CLOUDFLARE_API_TOKEN`
(account `0d781804fa06b08ae55e36c7e63dbce1`), which was never printed.

### 1. Native Git integration: blocked at first (resolved in section 6)

```bash
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -X POST https://api.cloudflare.com/client/v4/accounts/$A/pages/projects \
  --data '{"name":"greenhouse-board","production_branch":"main",
           "build_config":{"build_command":"npm ci || npm install; npm run board:build","destination_dir":"board/dist"},
           "source":{"type":"github","config":{"owner":"johnmafly","repo_name":"greenhouse",
             "production_branch":"main","preview_deployment_setting":"none", ...}},
           "deployment_configs":{"production":{"env_vars":{"NODE_VERSION":{"type":"plain_text","value":"24"}}}}}'
# {"success":false,"errors":[{"code":8000011,"message":"There is an internal issue with your
#   Cloudflare Pages Git installation. If this issue persists after reinstalling your installation, ..."}]}
```

Same error with `owner_id`/`repo_id` added, and for a throwaway project on the already-connected
`johnmafly/run-portal` repo. The cause:

```bash
curl ... /accounts/$A/pages/connections
# [{"type":"github","owner":"agenthatch-ai","provider_account_id":"272704718",
#   "settings_url":"https://github.com/settings/installations/121386826",
#   "has_valid_oauth_token":false,"created_on":"2026-04-04T15:04:49Z"}]
```

The only Pages Git connection is for GitHub user `agenthatch-ai`, and its OAuth token is not
valid. There is no connection for `johnmafly`, which owns `johnmafly/greenhouse`
(repo id 1462593546, owner id 32551433, public). The older `run-portal` project was connected
in 2022 by a since-lapsed link and last deployed from Git on 2024-06-30.

**Owner step to enable native Git deploys** (needs johnmafly signed in to Cloudflare and GitHub):
Cloudflare dashboard, Workers & Pages, Create, Pages, Import an existing Git repository,
GitHub, Add account, install "Cloudflare Workers and Pages" on `johnmafly` (all repositories,
or at least `greenhouse` and future project repos). Stop once `johnmafly/greenhouse` is listed;
projects are created by API.

### 2. Fallback (retired 2026-11-18, see section 6): GitHub Actions direct upload

- Pages project `greenhouse-board` created as a direct-upload project
  (id `401737b6-97c8-4152-8613-f380e6b6a791`, `greenhouse-board.pages.dev`, created
  2026-11-18T09:49:39Z, `source: null`). Direct-upload projects cannot later be switched to Git
  integration; moving to native Git means a new project and moving the custom domain.
- Deploy token: account-owned API token `greenhouse-board-deploy (GitHub Actions, johnmafly/greenhouse)`,
  id `a872e7e75fea4eb72235d48b367ff7b9`, created with `POST /accounts/{id}/tokens`, one policy:
  `Pages Write` on `com.cloudflare.api.account.0d781804fa06b08ae55e36c7e63dbce1`. Verified
  `active` with the account-level verify endpoint. Stored with
  `printf '%s' "$NEWTOK" | gh secret set CLOUDFLARE_API_TOKEN -R johnmafly/greenhouse` (value
  never printed or written to disk), plus `CLOUDFLARE_ACCOUNT_ID`.
- Scope probe with a second identical token (deleted right after):

  | Call | Result |
  |---|---|
  | List Pages projects | allowed |
  | Read another Pages project (`run-portal`) | **allowed** |
  | List DNS records of `agenthatch.ai` | denied (10000) |
  | Upload a Worker script | denied ("No access to the specified resource") |
  | List R2 buckets | denied (10000) |
  | List Workers scripts | allowed (read-only listing) |

- Workflow `.github/workflows/deploy-board.yml`: `on: push: branches: [main]` only (never
  `pull_request`, so pull requests and forks never see the secret), `permissions: contents: read`,
  serialised by a concurrency group, runs `npm run board:build` then
  `npx wrangler@4.164.0 pages deploy board/dist --project-name greenhouse-board --branch main --commit-hash $GITHUB_SHA`.
- Initial deployment, made by hand with the same command from the #1 branch so the board is
  live before the workflow reaches `main`:

  ```
  id 3737d656-4d26-4d35-a0a2-fbc2212b5944  env production  trigger ad_hoc
  sha c1563f5d3c3603acb923c8ed6019b0fbaf5636e3  status success
  ```

  The workflow then deployed the #22 merge: `deploy-board` run 44280700905 on `f45eefb`
  succeeded, giving production deployment `9edaab0a` with `commit_hash`
  `f45eefbc63a91725931bfb08915a8be5f3796be4`. It also deployed the next merge (`7f3d75e`, run
  44280902319) before it was retired.

### 3. Custom domain

```bash
POST /accounts/$A/pages/projects/greenhouse-board/domains {"name":"greenhouse.agenthatch.ai"}
# id 06017129-76a0-4c20-980a-edbd6410bb9e, status initializing
POST /zones/8c53a22235a75eedbf130da7d5d72f3c/dns_records
  {"type":"CNAME","name":"greenhouse","content":"greenhouse-board.pages.dev","proxied":true}
# id 95a7d88d95888f667772cd8ef6ec99e4
```

The Pages API does not create the DNS record for an API-added domain; it has to be created on
the zone (zone `agenthatch.ai`, Free plan, same account). Minutes later the domain served
(the Pages domain object still read `status: pending` while certificate validation finished):

```
$ curl -sSI https://greenhouse.agenthatch.ai/
HTTP/2 200
x-robots-tag: noindex, nofollow
server: cloudflare
```

### 4. Public + noindex

`board/public/_headers` is copied into `board/dist` by `board/build.ts`:

```
/*
  X-Robots-Tag: noindex, nofollow
```

```
$ curl -sSI https://greenhouse-board.pages.dev/      $ curl -sSI https://greenhouse.agenthatch.ai/
HTTP/2 200                                           HTTP/2 200
x-robots-tag: noindex, nofollow                      x-robots-tag: noindex, nofollow
```

No redirect to `cloudflareaccess.com`, no `cf-access-*` headers; the account's Access
applications cover only `*.realb.bid` hosts. Both hostnames are publicly reachable.
Notes: `_headers` does not apply to Pages Functions responses (none here), and a missing path
such as `/robots.txt` returns the index page (Pages' default without a `404.html`), still with
`noindex`. Publishing at graduation means removing the rule from that project's `_headers`.

### 5. Free-plan limits that matter

From [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) (checked 2026-11-18):

| Limit | Free | Pro | Why it matters |
|---|---|---|---|
| Builds | 1 at a time, 500/month (per account) | 5 at a time, 5,000/month | Native Git builds of every project repo share this. Direct uploads from Actions do not use Cloudflare builds. |
| Build timeout | 20 minutes | | |
| Projects per account | 100 (not routinely raised) | | One per seed plus the board. New accounts are throttled in their first 48 hours. |
| Custom domains per project | 100 | 250 | |
| Files per site / file size | 20,000 / 25 MiB | 100,000 | Screenshots belong in R2 (v7 section 4). |
| `_headers` | 100 rules, 2,000 chars per header | | |

Direct upload via CI: [Use Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).
Headers: [Pages headers](https://developers.cloudflare.com/pages/configuration/headers/).

### 6. Native Git integration in force (follow-up, same day)

The owner installed the Cloudflare Workers and Pages app on `johnmafly`:

```bash
curl ... /accounts/$A/pages/connections
# [{"owner":"johnmafly","provider_account_id":"32551433",
#   "settings_url":"https://github.com/settings/installations/183261034",
#   "created_on":"2026-11-18T09:53:18Z", ...}, {"owner":"agenthatch-ai", ...}]
curl ... /accounts/$A/pages/connections/github/johnmafly/repos
# lists greenhouse (repo_id 1462593546), among others
```

Both connections still report `has_valid_oauth_token: false`; project creation and builds
work regardless, so that flag is not a blocker.

Switch, all by API with the account token (never printed):

1. Removed the custom domain from the direct-upload project (Pages refuses to delete a project
   with custom domains, error `8000028`), then deleted project
   `401737b6-97c8-4152-8613-f380e6b6a791`.
2. Recreated `greenhouse-board` (the name was reusable at once, so the hostname
   `greenhouse-board.pages.dev` and the DNS record are unchanged), id
   `c67918ca-aaaa-4d07-95c1-bec33f08913e`:

   ```json
   {"name":"greenhouse-board","production_branch":"main",
    "source":{"type":"github","config":{"owner":"johnmafly","owner_id":"32551433",
      "repo_name":"greenhouse","repo_id":"1462593546","production_branch":"main",
      "pr_comments_enabled":false,"deployments_enabled":true,"production_deployments_enabled":true,
      "preview_deployment_setting":"none","preview_branch_excludes":["*"]}},
    "build_config":{"build_command":"npm ci || npm install --no-audit --no-fund; npm run board:build",
      "destination_dir":"board/dist","root_dir":""},
    "deployment_configs":{"production":{"env_vars":{"NODE_VERSION":{"type":"plain_text","value":"24"}}},
      "preview":{"env_vars":{"NODE_VERSION":{"type":"plain_text","value":"24"}}}}}
   ```

   With `preview_deployment_setting: none`, pull request branches (including forks) are never
   built, so nothing outside `main` runs in Cloudflare's build.
3. Reattached `greenhouse.agenthatch.ai` (domain id `df7b2963-e202-499f-aa5e-e8cc473dfeb9`,
   `active` within a minute). The CNAME `greenhouse` → `greenhouse-board.pages.dev`
   (record `95a7d88d…`) needed no change.
4. First Git build, triggered for `main` with `POST .../deployments` (`branch=main`):
   deployment `647dcfb1`, `commit_hash` `7f3d75e06a145e0c4e3032e2438377f1146a61e4`, build and
   deploy `success`. Later pushes to `main` build by themselves.
5. Retired the fallback: `gh workflow disable deploy-board.yml` (so merges before this record
   landed did not run it), repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   deleted (`gh secret list` is empty), the `board` Actions environment deleted, token
   `a872e7e75fea4eb72235d48b367ff7b9` deleted (`GET` now returns `1003 token not found`), and
   `.github/workflows/deploy-board.yml` removed by the pull request that updates this record.

After the switch both hostnames still return `HTTP/2 200` with
`x-robots-tag: noindex, nofollow`. The deployment for the merge of that pull request (a
`github:push` build whose `commit_hash` is the merge SHA) is recorded on the pull request.

## Options considered

1. **Native Pages Git integration** (v7). No credential outside Cloudflare. Was blocked until
   the owner connected `johnmafly`. **Chosen; in force.**
2. **GitHub Actions + wrangler direct upload** with a Pages-Write-only token in repo secrets.
   Was the fallback for the first day; **retired**.
3. Deploy from the Mac mini with the admin token. Rejected: ties deploys to the Mac mini being
   up and puts the account-wide token in the deploy path.

## Decision

- The board deploys by **option 1** (native Git integration). Option 2 is retired; its
  workflow, secrets and token are gone. Do not reintroduce a deploy token in any repo.
- Project repos get Git-connected Pages projects the same way (the `johnmafly` installation
  must cover them; today it lists every `johnmafly` repo), with `preview_deployment_setting:
  none` until v7 decides otherwise.
- Project sites stay public with `X-Robots-Tag: noindex` from `_headers` until the owner
  publishes; Access only when an intake asks for it.

## Risks and implications

- **Resolved by native Git: the account-wide Pages deploy token.** While the fallback ran,
  a Pages-Write token in repo secrets could overwrite any Pages project in the account
  (Cloudflare cannot scope a token to one project). It is deleted; no repo holds a Cloudflare
  credential now.
- **What a repo writer still controls.** With native Git, anyone who can land a commit on
  `main` controls what that repo's site serves (the build command runs the repo's own
  `npm run board:build`), but cannot reach other Pages projects, DNS or the account. The build
  settings (command, output dir, env) live in Cloudflare, not in the repo. `main` needs a
  pull request with green `ci` but 0 approvals, and every actor shares the workspace's GitHub
  identity, so this is tamper-evident (commits and deployments are logged), not tamper-proof.
  CODEOWNERS was considered and deferred as an owner decision: with one shared identity it
  would not bind.
- **Project repos.** Use native Git per repo; never the Actions fallback, which would hand a
  Chief an account-wide Pages credential through its own workflow.
- **Build quota.** Native Git builds count against the Free plan's 500 builds/month and
  1 concurrent build (section 5), shared by the board and every project repo.
- Direct-upload projects cannot be converted to Git-connected ones; the switch was a new project.
