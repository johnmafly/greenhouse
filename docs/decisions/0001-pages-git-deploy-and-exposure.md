# 0001: Pages deploys from GitHub, and public + noindex exposure (P0-A spike)

Issue: #1. Date: 2026-11-18. Plan v7 assumptions 2 and 3 (sections 9, 11, 14), adjusted by
owner decision 0000-1 (project sites are **public by default**, `noindex` until published).

## Summary

| Point | Answer | In force |
|---|---|---|
| Pages project connected to this repo through the Cloudflare GitHub app | **No, for now.** The account's only Pages Git connection is GitHub user `agenthatch-ai`; `johnmafly` is not connected, so the API returns `8000011`. | **Fallback:** GitHub Actions direct upload (`.github/workflows/deploy-board.yml`). |
| Push to `main` deploys with no token held by a Chief | **Fallback yes.** The deploy token lives only in this repo's Actions secrets, scoped to Pages Write; Chiefs never hold it. Native Git integration (no token at all) stays preferred once `johnmafly` is connected. | Actions workflow, runs only on `push` to `main`. |
| Custom domain `greenhouse.agenthatch.ai` | **Yes.** Attached to `greenhouse-board`, proxied CNAME to `greenhouse-board.pages.dev`, serves 200. | Live. |
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

### 1. Native Git integration: blocked

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

### 2. Fallback in force: GitHub Actions direct upload

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

  The first workflow deployment (trigger `ad_hoc`, `commit_hash` = the merge SHA on `main`)
  happens when this record's pull request merges; check with
  `GET /accounts/{id}/pages/projects/greenhouse-board/deployments` and the `deploy-board` run.

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

## Options considered

1. **Native Pages Git integration** (v7). No credential outside Cloudflare. Blocked until the
   owner connects `johnmafly`. Preferred.
2. **GitHub Actions + wrangler direct upload** with a Pages-Write-only token in repo secrets.
   Works today; chosen as the fallback.
3. Deploy from the Mac mini with the admin token. Rejected: ties deploys to the Mac mini being
   up and puts the account-wide token in the deploy path.

## Decision

- The board deploys by **option 2** now. Switch to **option 1** once the owner connects
  `johnmafly`: create a Git-connected project, move `greenhouse.agenthatch.ai` to it, delete
  `deploy-board.yml`, the two repo secrets and token `a872e7e7...`.
- Project sites stay public with `X-Robots-Tag: noindex` from `_headers` until the owner
  publishes; Access only when an intake asks for it.

## Risks and implications

- **The deploy token is account-wide for Pages.** Cloudflare cannot scope a token to one Pages
  project, so whoever can run code with this secret can overwrite or delete any Pages project
  in the account, including the board and every project site (it cannot touch DNS, Workers
  scripts or R2). The secret only runs from a workflow on `main`, and `main` requires a pull
  request with green `ci` but 0 approvals. Write access is the owner (`johnmafly`, admin) plus
  any Reason Session acting through the workspace's GitHub connection, which today includes
  any Chief that uses the same connection (v7 section 11 already flags this as tamper-evident).
  Before Chiefs exist, add a CODEOWNERS entry for `.github/workflows/` with a required owner
  review, or move to native Git deploys.
- **Project repos.** If native Git stays unavailable and project repos use the same fallback,
  each Chief's repo holds this secret, and a Chief can edit its own workflow to deploy anything
  anywhere in Pages. That breaks v7's "Chiefs hold no Cloudflare credential"; it is
  tamper-evident (workflow changes and deployments are logged) but not tamper-proof. So
  **project repos must not get the Actions fallback**: connect `johnmafly` (or the GitHub
  account that owns project repos) to Pages before onboarding the first seed (#13), or have
  the judge deploy project sites from the Mac mini with its own token instead.
- Direct-upload projects cannot be converted to Git-connected ones; the switch is a new project.
