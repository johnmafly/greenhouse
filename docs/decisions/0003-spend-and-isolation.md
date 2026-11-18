# 0003: Per-Chief spend and isolation (Phase 0 spike, v7 assumptions 5 and 6)

Date: 2026-11-18. Issue: #3. Plan v7 sections 11, 12, 14.
Everything below was observed from a VC Joe Session running on the Mac mini (agenthatchminisg)
as macOS user `agenthatch`, unless marked *inferred* or *not verified*.

## Summary

| Assumption | Result | Chosen control |
|---|---|---|
| 5. Per-Chief spend can be read | **Yes, by reading; no hard cap.** `sessions_get` returns `cost_usd` and token `usage` per Session. A Reason's spend is the sum over its Sessions. `execution_budget` does not track model spend and cannot be set. | Chief records spend in `STATE.md` from its own roll-up; VC Joe recomputes it per round; 80% flag; stop is VC Joe cancelling the Chief's Sessions (soft cap). Chief Reasons must be team-shared so VC Joe can read them. |
| 6a. GitHub isolation | **Tamper-evident, not tamper-proof.** All Reasons act as one GitHub identity (`reason-machines[bot]`), and the Mac mini's `gh` CLI is signed in as the owner (admin) for every Session. | Branch protection applied (below). Merge audit: every commit on `main` must come from a merged PR. `repos_guardrails` cannot separate Reasons. |
| 6b. Mac mini isolation | **No wall, only a tripwire.** Every Session runs as `agenthatch` with full shell access, can read `greenhouse-judge`, and receives every brokered workspace secret, including `CLOUDFLARE_API_TOKEN`. | CANARY tripwire now. Separate macOS user for the judge (owner action) before the first real Chief round, with the Cloudflare token moved off the broker. |

## 1. Spend (assumption 5)

### What is available

| Source | Per Session | Per Reason | Notes |
|---|---|---|---|
| `sessions_get` → `cost_usd`, `usage.{input,output,total}_tokens` | Yes | Sum over the Reason's Sessions | `null` while a Session's first turn is running; filled when a turn ends. Cumulative across turns (*inferred*: VC Joe's main conversation, many turns, reports 1.74M input tokens, $3.57). |
| `sessions_get` → `execution_budget` (`spent_usd`, `spend_limit_usd`, `deadline_at`) | Readable | Shared by a Session's tree | **Not model spend.** The plan-review Session shows `cost_usd` $4.10 with `execution_budget.spent_usd` $0; BotRampart's main conversation $2.77 vs $0.0009. `spend_limit_usd` is `null` everywhere and no tool sets it (`sessions_create` has no budget field). |
| `sessions_search` (no query) | Lists Sessions | Own Reason by default; `all_reasons: true` adds the person's other Reasons | Results carry no `reason_id` or cost; each needs a `sessions_get`. |
| `computers_list` / `machines_usage` | No | No | Machine resources only, no model spend. |

Boundaries found:

- **Team reach.** VC Joe is a team Reason. `sessions_get` on a Session filed under a personal (unshared) Reason fails with `session_out_of_team_reach`. In a sample of 40 Sessions from `all_reasons`, 12 were readable and 28 were not. BotRampart's main conversation (Reason `8027c802…`) was readable.
- **Rate.** A codemode script may make at most 64 Reason operations, so a roll-up over many Sessions must page across scripts.
- **Model source.** All Greenhouse Sessions so far use the owner's own Anthropic connection on this Mac (`desktop-local`). `cost_usd` is Reason's computed cost for that usage; whether it equals what the owner is billed is **not verified**.
- Whether a parent Session's `cost_usd` includes its subagents is **not verified**. Subagents are separate Sessions, so summing every Session of the Reason counts them once either way only if parents exclude children. Phase 1 measures this on the first judged round.

### Chosen control

1. **Chief self-report.** Each Chief keeps `spend_usd` and `as_of` in `STATE.md`, computed in its own Session by listing its own Reason's Sessions (`sessions_search` without `all_reasons`) and summing `sessions_get(...).session.cost_usd`.
2. **Judge recompute.** At every judged round VC Joe recomputes the Chief's spend independently: list with `sessions_search({ all_reasons: true })`, keep Sessions whose `reason_id` is the Chief's, sum `cost_usd`, 50 `sessions_get` calls per script. The recomputed number is the one recorded in `score.json`/the board; a gap over 10% from `STATE.md` is a finding.
3. **Precondition.** A Chief's Reason must be shared with the team (or otherwise in VC Joe's reach). Onboarding checks this with one `sessions_get` on the Chief's conversation.
4. **Caps are soft.** 80% of the intake's model-spend cap triggers the owner alert; 100% pauses the project and VC Joe stops the Chief's running Sessions with `sessions_cancel`. Reason has no per-Reason hard stop today.

Roll-up sketch (codemode, run by VC Joe):

```js
const CHIEF = "<chief reason id>";
const { sessions } = await tools.sessions_search({ all_reasons: true, limit: 50 });
let usd = 0, open = 0;
for (const s of sessions) {
  const g = (await tools.sessions_get({ session_id: s.session_id }).catch(() => null))?.session;
  if (!g || g.reason_id !== CHIEF) continue;
  if (g.cost_usd == null) open++; else usd += g.cost_usd;
}
return { usd, sessions_with_turn_in_progress: open };
```

## 2. GitHub isolation (assumption 6a)

### Observed

- `main` on both repos had **no branch protection and no rulesets** (`GET .../branches/main/protection` → 404 "Branch not protected"; `GET .../rulesets` → `[]`).
- The owner account is on GitHub **Pro**, so branch protection works on the private `greenhouse-judge`.
- **One identity.** The scaffold commit and the first PR (#18, opened by the #2 spike Session) are both authored by `reason-machines[bot]` (`app/reason-machines`). Every Reason in the workspace pushes, opens and merges through that one GitHub App; Session checkouts push through Reason's git proxy (`api.reasonmachines.com/git/github.com/...`). GitHub cannot tell VC Joe from a Chief.
- **Owner credentials on the machine.** The Mac mini's `gh` CLI is signed in as `johnmafly` (scopes `repo`, `workflow`, `read:org`, …) in the `agenthatch` keyring, which every Session on the machine can use. That identity is a repo admin.
- The CI check run on `main` is named `ci` and comes from the `github-actions` app (GitHub App id 15368).
- `repos_guardrails` (both repos, read) controls what *Reason* does unasked in a repo: auto-fix of new issues, auto-merge rules and the merge bot's protected paths and size limit, browser use, install scripts. It is per repository for the whole workspace, not per Reason, so it **cannot stop one Reason from pushing to or reading a repo** the workspace connection reaches. Changing it needs the owner's own chat turn. Both repos currently have `auto_fix_new_issues: true`.
- Both repos are connected with a team grant, so any Reason in the workspace can reach `greenhouse-judge` through the repository tools (*inferred* from the grant; not tested from a Chief).

### Applied (after this PR was opened)

`johnmafly/greenhouse` `main`:

- pull request required, 0 approvals (every author is the same bot, which cannot approve its own PR);
- required status check `ci`, pinned to the GitHub Actions app (id 15368) so no other app or commit status can satisfy it; not strict (parallel PRs do not need to rebase after each merge; CI also runs on every push to `main`);
- admins not enforced (VC Joe/owner can recover), force pushes and deletion blocked.

`johnmafly/greenhouse-judge` `main`: pull request required (0 approvals), admins not enforced, force pushes and deletion blocked.

The exact calls and the read-back are in the PR that added this record.

### What this does and does not stop

- Stops: a Session (any Reason) pushing directly to `main` through the Reason App, force-pushing over history, merging a PR with red or missing `ci`.
- Does not stop: any Session on the Mac mini using the owner's `gh` login to bypass (admins not enforced) or edit the protection, or a Chief merging its own PR through the shared App once `ci` is green. Per-folder push restrictions (push rulesets) are documented for organization-owned repositories, not a personal one like this (not tested here), so the v7 path-guard stays a CI check.

### Chosen control

1. Branch protection above.
2. **Path-guard as part of `ci`** (owned by the CLI/submission issue): a `submission:` PR may only add `portfolio/<slug>/rounds/NN/submission.yaml`.
3. **Merge audit (tamper evidence).** The board build and the daily sweep check that every commit on `main` since the last audit is associated with a merged PR (`GET /repos/{o}/{r}/commits/{sha}/pulls`) and that `score.json` input hashes match. A miss is an incident reported to the owner.
4. Only VC Joe merges `submission:` PRs; Chiefs are told so in their brief. This is policy, not enforcement, until Chiefs have their own GitHub identity.

## 3. Mac mini isolation (assumption 6b)

### Observed

- Every bot runs as macOS user `agenthatch` (uid 503, member of `admin`). Passwordless `sudo` is not available (`sudo -n true` → "a password is required").
- A Reason Session works in its own folder (`~/.reason/workspace/sessions/<id>/repo`) but has `exec.full` on the whole home folder: from this Session, `~/workspace/vc-joe/greenhouse-judge` is listable and its `CANARY` and `README.md` are readable (checked with `test -r`; contents not read). The judge clone's own permissions (`drwx------ agenthatch`) do not help, because every Session *is* `agenthatch`.
- The Mac mini is registered as **one** Reason device with one root (`workspace`); every Reason that runs here gets the same access.
- **Secrets.** `CLOUDFLARE_API_TOKEN` is an organization-scope workspace secret with the connected-computer broker on (`secrets_list`: `scope: organization`, `on_this_computer: true`), and it is present in this Session's environment. Per Reason's own rule, such a secret reaches *every* Session on a connected computer, so a Chief Session on this Mac receives it too (*inferred* from that rule; not tested from a Chief). The token is active and account-scoped (`/accounts/{id}/tokens/verify` → `success: true, status: active`; the user-level verify fails as expected). This contradicts owner decision 0000 §2 ("stays only in the judge's environment, never with Chiefs").
- A "Reason"-scope secret never reaches a connected computer (cloud only), so Reason offers no per-Reason secret on the Mac mini.

### Tripwire (CANARY) design

- `greenhouse-judge` holds a random canary string (`CANARY`, already present) that appears nowhere else. Every judge file a Chief must not read (reviewer briefs, validation labels, answer key, red-team cases) carries it, in a comment or front matter, so copying any of them carries it.
- The judge, never the public CLI or this repo, loads the canary at run time and searches: the project repo tree at the submitted SHA, the built site output, the frozen evidence bundle's text, and the submission PR. Any hit fails the round, caps the composite at 5.0, and is reported to the owner as a suspected breach.
- The canary is never committed to `greenhouse`, never passed to Chiefs, never printed in logs; the judge rotates it after any hit.
- Limit: a Chief that reads the answer key and paraphrases it carries no canary. This detects copying, not reading.

### Separate macOS user for the judge: feasible, needs the owner

- macOS supports it and the machine is a normal admin-managed Mac. Creating a user needs the admin password (`sysadminctl -addUser`), which no Session has; **no user was created**.
- The judge user would run its own Reason CLI as a **separate Reason device** (the CLI is a per-user process; *inferred*, not tested). Judge Sessions target that device; Chiefs keep `agenthatch`.
- Required with it: judge home `chmod 700` (macOS homes are group-`staff` readable, and `agenthatch` is in `staff`), `greenhouse-judge` cloned only there, and the Cloudflare token kept only there (local file mode 600 or that user's keychain) with its broker switch **off**. While the token stays an organization secret with the broker on, a new device would receive it as well, so a second user alone does not contain it.
- Not covered: the owner's `gh` login and other brokered secrets in `agenthatch` remain reachable by Chiefs. Giving Chiefs a separate user instead (and leaving the judge on `agenthatch`) would contain those too, at the cost of a second Reason CLI login for every Chief.

### Chosen control

- **Now (Phase 0/1, demo projects only):** wall with a tripwire. Chief brief rule, CANARY gate, judge material only in `~/workspace/vc-joe/greenhouse-judge`. Accepted because no real Chief has run a judged round yet.
- **Before BotRampart's first judged round (owner action):** create a judge macOS user, register it as its own Reason device, move `greenhouse-judge` and the Cloudflare token there, and switch the token's broker off (or move Chiefs to their own user). Until then, the Cloudflare token is reachable by any Session on the Mac mini, and v7 §11 should say so.

## Evidence (commands and results)

| Check | Command / call | Result |
|---|---|---|
| Spend fields | `sessions_get` on this Session, the build lead, the plan review, VC Joe's and BotRampart's conversations | Running: `cost_usd` null, `execution_budget.spent_usd` 0. Finished plan review: `cost_usd` 4.10, 723,461 tokens, `spent_usd` 0. BotRampart: `cost_usd` 2.77, `spent_usd` 0.0009. All `spend_limit_usd` null. |
| Team reach | `sessions_search({all_reasons:true, limit:40})` + `sessions_get` each | 12 readable, 28 `session_out_of_team_reach` |
| Op cap | 100 `sessions_get` in one script | error after call 64: "One script may run at most 64 Reason operations" |
| Protection before | `gh api repos/johnmafly/{greenhouse,greenhouse-judge}/branches/main/protection` | 404 "Branch not protected" (both); rulesets `[]` |
| Plan | `gh api user --jq .plan.name` | `pro` |
| Identity | `gh api repos/johnmafly/greenhouse/commits`, `gh pr list` | author/committer `reason-machines[bot]`; PR #18 author `app/reason-machines` |
| CI check name | `gh api repos/johnmafly/greenhouse/commits/main/check-runs` | `ci`, app `github-actions`, success |
| Guardrails | `repos_guardrails` (read) on both repos | Reason-behaviour settings only; `auto_fix_new_issues: true` |
| macOS user | `id`, `sudo -n true` | `agenthatch` in `admin`; sudo needs a password |
| Judge readable | `test -r` on files in `~/workspace/vc-joe/greenhouse-judge` | `CANARY`, `README.md` readable |
| Secret reach | `secrets_list`; `test -n "$CLOUDFLARE_API_TOKEN"` | organization scope, `on_this_computer: true`; set in this Session |
| Token scope | `curl .../accounts/<id>/tokens/verify` and `.../user/tokens/verify` | account: success, active; user: fails (code 1000) |

## Open questions for the owner

1. Create a separate macOS user for the judge (or for Chiefs) before BotRampart's first judged round? Recommended: yes, judge user, token off the broker.
2. Turn `auto_fix_new_issues` off on `greenhouse-judge` (and on `greenhouse`, where issues are assigned to Sessions by VC Joe)? Needs the owner's own turn in `repos_guardrails`.
3. Is `cost_usd` on the owner's own Anthropic connection the spend number the intake cap should use?
