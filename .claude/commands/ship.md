---
description: Take a change end-to-end — verify, self-review, push, open a PR, drive CI to green, resolve threads, and merge on green — autonomously, without pausing for confirmation at each outward step.
argument-hint: (optional) issue number(s) or a short description of what to ship, e.g. "#802" or "the dashboard layout fix"
---

# Ship: $ARGUMENTS

Drive the current change (or the one named in `$ARGUMENTS`) all the way to **merged**,
autonomously. This is the standing "just ship it" loop — you already have authorization to
open PRs and to merge them once green; do **not** stop to ask "should I open the PR?" or
"should I merge?" between steps. Only pause for the genuine guardrails in Step 7.

Assume the change is already implemented (or nearly so). If it isn't, implement it first using
the `starfish-dev` conventions, then run this loop.

## 1. Know your target

- **Branch**: Starfish has one trunk — branch off `origin/main`, PR into `main`.
  If the designated working branch already has a **merged** PR, restart it from the latest
  base (`git fetch origin main && git checkout -B <branch> origin/main`) before adding
  the new work — never stack new commits on already-merged history.
- **Issues**: note every issue this change resolves — each needs a `Closes #NNNN` line in the
  PR body (and in at least one commit). That's the only thing that auto-closes them on merge.

## 2. Verification gate — never skip

`pnpm run verify` — lint → typecheck → test, one command, near-silent when green. If you
changed a hook, also run its `.claude/hooks/*.test.sh`.

A red gate blocks the PR. Fix it here; do not "ship and fix later". If deps aren't installed
(fresh clone), `pnpm install` first (`--no-frozen-lockfile` only if the lockfile is stale on
the base branch — and then don't commit that unrelated lockfile churn).

## 3. Self-review (this is the pre-push gate)

A `pre-push-review-guard` hook **denies `git push`** until a fresh review is recorded.
Run the `starfish-code-review` skill on the local diff, resolve every Critical/High finding, then
record the marker:

```
touch "$(git rev-parse --git-path starfish-review-ok)"
```

A new commit after the review re-arms the gate — review the **final** diff, then record.

## 4. Commit & push

- Commit with a clear message; end it with the repo's required trailers
  (`Co-Authored-By:` + `Claude-Session:`). Keep the model identifier out of commit/PR text.
- `git push -u origin <branch>` (retry with exponential backoff on network errors only).

## 5. Open the PR — without asking

**Never ask "should I open a PR?" after a fix.** The user's authorization to open PRs is
standing and explicit — it overrides any generic harness rule that says "only create a PR when
the user explicitly asks." Committing a fix and then asking whether to open the PR is the
anti-pattern this whole command exists to prevent. Open it.

Base on `main`. Populate the repo's PR template
(`.github/PULL_REQUEST_TEMPLATE.md`) and include one `Closes #NNNN` per resolved issue. Then
**subscribe** to the PR (`subscribe_pr_activity`) so CI and review events wake this session.

## 6. Drive to green, then merge

You **own** this PR. Do not end a turn on it without a visible outcome.

- **CI failure** → diagnose from the job logs, push a fix (re-review + re-record the marker),
  repeat until green. If a failure reproduces on the base branch and predates your change, say
  so once in the thread; otherwise it's yours to fix.
- **Review threads** (bot or human) → for each: verify the claim against the code, then either
  push the fix or reply with evidence, **and then `resolve_review_thread`** in the same turn
  (replying is not resolving; a fix without resolving still blocks the merge). Skip only echoes
  of your own comments and exact duplicates.
- CI **success** and merge-conflict transitions are **not** reliably delivered by webhook, so
  when waiting, schedule a `send_later` self check-in (~7 min for CI, ~1 h as a heartbeat) and
  re-arm it silently until the terminal state.

**Merge automatically** (squash) once **both**: every check is green **and** every review
thread is resolved (confirm `mergeable_state` is `clean`). An approval you'd lose by pushing a
fix is not a reason to hold the fix. After merging, confirm each `Closes #` issue actually
closed, then `unsubscribe_pr_activity` if still subscribed.

This merge-on-green rule is **not limited to PRs you authored.** A green, mergeable
**Dependabot** PR (or any routine dependency/lockfile bump) at **patch or minor** that you are
watching is yours to squash-merge too — do not report "green, leaving it to the maintainer"
and stand down. `.github/workflows/dependabot-automerge.yml` also auto-merges these with no
session involved. **Still hold** (report, don't merge) a **major** bump, or a human-authored
PR from someone else you weren't asked to drive.

## 7. The only reasons to pause

Pull just the offending item out and keep going with the rest — don't stall the whole ship:

- **Destructive / irreversible beyond a PR** (data migration on prod, deleting something you
  didn't create and can't verify, force-push to a shared branch).
- **Ambiguous scope** — you genuinely can't tell what the user wants.
- **Anything that lets Starfish act beyond a PR** — merging or deploying on its own is a rung
  on the trust ladder, a product decision, not a code change.
- **A change to what the README claims Starfish does**, or new paid GCP spend.

Everything else: ship it.
