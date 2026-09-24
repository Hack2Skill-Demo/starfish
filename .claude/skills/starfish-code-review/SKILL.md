---
name: starfish-code-review
description: Review a Starfish pull request or local diff for correctness, security, and Starfish-convention violations, then optionally post the findings as inline PR review comments — and, on the receiving side, work through review feedback left on your own PR. Invoke for "review this PR", "review PR #NNN", "code review the diff", "review my changes before I push", or any request to audit a change. Also the pre-push gate — .claude/hooks/pre-push-review-guard.sh blocks git push until this has run. Also invoke for the inbound direction: "address the PR comments", "fix the review feedback", "watch/babysit this PR", "CI is red on my PR". Covers the config boundary, what reaches the model, never-throw contracts, ingest dedup/classification invariants, Firestore write rules, honesty of claims, and the verification gate.
---

# Starfish Code Review

You are standing in for an automated PR reviewer. Read a change, find the problems that
actually matter, and report them precisely — file + line, severity, why it's wrong, and the
fix. Be specific, correct, and quiet about trivia.

This skill runs in **two directions**:

- **Outbound** (§1–4) — you are the reviewer. Review-only: it does not implement. If the
  user wants findings fixed, review first, then offer to fix.
- **Inbound** (§5) — someone reviewed *your* PR. Work their feedback to resolution. This
  direction **does** change code.

Starfish is an incident → verified-PR engine for Firebase/GCP projects, meant to be adopted
by configuration alone, built on Gemini for a competition that grades Gemini. Review with
those three facts in view.

## 1. Establish the review target

- **A specific PR** ("review PR #12") → fetch it with the GitHub MCP tools
  (`pull_request_read` for metadata + files + diff). Note base and head SHA.
- **The current branch vs. its base** ("review my changes", or the pre-push gate) → Starfish
  has one trunk, so: `git diff origin/main...HEAD`.
- **Uncommitted work** → `git diff` and `git diff --staged`.

Read the **full diff plus enough surrounding context** to judge correctness — a hunk in
isolation lies. Open the changed files, not just the patch. For a change to an ingest
file, read the test that pins its invariant first: most of those rules exist because a
production incident broke them once.

## 2. What to look for (in priority order)

The authoritative detail lives in `CLAUDE.md` and the `starfish-dev` skill.

### A. Correctness & bugs (highest priority)
- Logic errors, off-by-one, wrong conditionals, unhandled null/undefined, **un-awaited
  promises** (lint's `no-floating-promises` is the net — an un-awaited write fails silently,
  and silent failure is the one thing an ops tool can't have).
- **Valid-looking code that throws on a realistic input.** The best finds in this codebase
  are this class: `Timestamp.fromDate(new Date("garbage"))`, `JSON.parse` on model output
  with no guard, a Firestore field that is a string on a legacy doc, `String(obj)` producing
  `[object Object]`. Ask of every new line: what does production actually send here?
- **Never-throw contracts.** `runLogCounterCheck`, `fetchRecentErrorSamples` and friends
  promise to degrade, not throw. A change that lets an exception escape one of them loses the
  incident. And **missing is not zero**: a failed check must return `null`, never a 0 count
  that triage will read as "noise".
- **Ingest invariants** (each pinned by a test — a change that breaks one is Critical):
  classification order is source class > structured code > HTTP status > keywords; an
  unattributable function is `"platform"`, never the first configured service; a resolved
  incident is never reopened; an open incident is found **by fingerprint**, never by scanning
  a function's open docs; a recurrence never undoes a triage decision; `fingerprint` is
  stable across versions, so existing incidents keep deduplicating.
- **Firestore writes**: `undefined` is rejected — optional fields must be spread
  conditionally. Batches cap at 500 writes. A batch commit failure must not leave counters
  claiming writes that didn't land.
- **Unbounded reads**: Cloud Logging `getEntries` auto-paginates by default. Every read
  needs a cap (`maxResults`, or `autoPaginate: false` + a counter) — the burst that makes a
  read huge is exactly the incident the job exists to catch.

### B. What reaches the model (highest priority)
- **Everything sent to Gemini is redacted and bounded** — `sanitize()` / `redactPii()` +
  truncation. A new field on the incident that goes to the model unsanitized is High; one
  that can carry credentials (`token`, `authorization`, `apiKey`…) is Critical.
- **Incident text is untrusted data.** Production logs are attacker-influenceable. Any new
  prompt must go through `askJson` (which appends the untrusted-data notice), and nothing
  the model returns may be executed, applied, or used as a filter without validation.
- **Structured output, not scraping.** A verdict parsed by regex out of free text is a bug.
- **Cloud Logging filter injection**: any value interpolated into a filter must go through
  the `quote()` escaper or the function-name charset sanitizer in `parseLogEntry.ts`.

### C. Starfish conventions (block on these — they're non-negotiable)
- **Configured, never forked.** Anything deployment-specific outside `src/config.ts` is
  Critical: a project id, a service name, a resource type, a collection name, a model id, a
  noise pattern. (`config-boundary-guard.sh` catches `process.env`; you catch the hardcoded
  literal.) A new setting also needs `.env.example` and a sensible default.
- **Never merges, never deploys.** Any code path that could merge a PR, push to a protected
  branch, or deploy is Critical unless the README's trust ladder has explicitly reached that
  rung (it hasn't).
- **Gemini stays the engine.** Swapping the triage/fix/review model to a non-Gemini provider
  breaks the competition's hard requirement.
- **Honesty.** README/docs claims must match the code. "✅" on something unbuilt, or a
  status table not updated when a row changed, is a High finding.
- **`Closes #NNNN`** in the PR body (and commit) for every issue the PR resolves.

### D. Quality & maintainability (report, don't block)
- Duplication that should reuse an existing helper (`sanitize`, `quote`, `buildLogFilter`,
  `extractErrorDetail`); dead code; unused vars (remove, don't `_`-prefix).
- Missing tests for new branches — particularly a fix without a test that fails before it.
- Comments that explain *what* instead of *why*. This codebase's comments record the
  incident that taught each rule; keep that standard.

### E. The verification gate
Did the author run `pnpm run verify` (lint → typecheck → test)? If the diff plausibly breaks
any step, say so. Hook changes need their `.test.sh` suite updated and passing.

## 3. Severity — label every finding

Use a four-level scale (mirrors the reviewer this replaces, so triage stays familiar):

- **🔴 Critical** — will crash, corrupt or lose incidents, leak credentials/PII to the model,
  or let Starfish act beyond a PR; also the non-negotiable convention violations (hardcoded
  deployment specifics, a broken ingest invariant). Must fix before merge.
- **🟠 High** — real bug with narrower blast radius (unhandled throw on a bad input, a path that
  fails for a configuration the code should tolerate). Fix before merge.
- **🟡 Medium** — should-fix: correctness/maintainability problem that won't take down a flow.
- **🟢 Low** — nit / style / preference. Mention sparingly; prefix "nit:".

The best finds are concrete runtime-crash bugs — e.g. `Timestamp.fromDate` on an Invalid Date
from a malformed log timestamp, which throws and fails the whole write batch over one entry.
Hunt for that class of "valid-looking code that throws on a realistic input."

If you find nothing material, say so plainly — don't manufacture findings to look thorough.

## 4. Output

Default to a **chat summary**: a one-line verdict, then findings grouped by severity, each as
`path:line — problem — fix`. Lead with the highest severity.

**Pre-push gate.** A `PreToolUse` hook (`.claude/hooks/pre-push-review-guard.sh`) blocks
`git push` until a review is recorded. When you've run this review on the local diff as that
gate and resolved all Critical/High findings, record it so the push can proceed:

```
touch "$(git rev-parse --git-path starfish-review-ok)"
```

(Use `--git-path`, not a literal `.git/starfish-review-ok` — in a git worktree `.git` is a file,
not a directory, so the literal path can't be created there. `--git-path` resolves correctly
in both a normal checkout and a worktree.)

The marker is invalidated by any later commit (its mtime must be ≥ the latest commit), so only
record it once the diff you reviewed is the diff you're about to push.

When the user asks to **post on the PR** (or says "like the bot / Gemini did"), match that
format so it's a true drop-in:

1. `pull_request_review_write` to open a pending review. Start the review **body** with a
   `## Code Review` heading and a short paragraph summarizing the change and the main risks
   found — the same shape the prior reviewer used.
2. `add_comment_to_pending_review` for each finding, anchored to file + line. Each inline
   comment is: **severity label** (Critical / High / Medium / Low) → one or two sentences on
   *why it breaks and on what input* → a GitHub suggestion block with the actual fix:

   ````
   ```suggestion
   <the corrected line(s)>
   ```
   ````

   Use a `suggestion` block whenever the fix is a concrete edit to the commented line(s) (it
   gives the author one-click apply); fall back to a fenced code snippet when the fix spans
   other lines.
3. Submit the review: **request changes** if there are Critical/High findings, otherwise
   **comment** (or approve when clean).

Unlike a chat summary, when posting on the PR flag **each occurrence** of a recurring bug on its
own line — every spot then gets its own one-click suggestion (this is why the prior reviewer left
the same note on all four `new URL()` sites rather than once). Keep the explanation terse on the
repeats. Post substantive findings only — skip pure noise. Keep the model identifier and any
internal tooling notes out of anything posted to GitHub.

## 5. Inbound: working feedback on your own PR

When a PR you opened has review comments or red CI, drive it to resolution rather than
reporting on it. **You own every PR you opened in the session** — nobody else is going to
land it. If the repo requires conversation resolution before merge, so **an unresolved thread
blocks the merge even when every check is green** — the PR reports `mergeable_state:
"blocked"` with no failing check to explain it. Resolving threads is part of finishing a
PR, not housekeeping to do later.

### 5.1 Make the feedback actually reach you

A skill only runs when it's invoked; it cannot poll. The thing that makes this automatic is
the subscription, so set it up **as soon as the PR exists**:

```
subscribe_pr_activity(owner, repo, pullNumber)
```

Review comments, CI transitions and merge-conflict notices then arrive as PR-activity
events that wake the session. Never `sleep`-poll for them. Webhooks are best-effort and
drop CI-success and new-push events, so also schedule a `send_later` check-in — per the
"Drive owned PRs to green yourself" rule in `CLAUDE.md` — and re-arm it silently while the
PR is open. Unsubscribe once it merges/closes, or the moment the user says stop.

If a Claude PR Steward already holds the watching label on the PR, the subscribe call
succeeds but events go to it, not you — the tool result says so. Don't silently assume
you're watching.

### 5.2 Read everything before changing anything

Comments live in **three** places and it's easy to see only one:

| Source | Tool |
|---|---|
| Inline review threads | `pull_request_read` → `get_review_comments` |
| Top-level PR comments (most bots post here) | `pull_request_read` → `get_comments` |
| CI job status | `pull_request_read` → `get_check_runs` |

Fetch all three. A green checks list plus an unresolved thread still means work to do.

### 5.3 Triage each comment — three outcomes, no fourth

1. **Fix it** — confident, small, in scope. Change the code, verify (§5.5), push, reply,
   **then resolve the thread** (§5.6).
2. **Ask first** — ambiguous, or a product decision the code can't make (e.g. moving a rung
   on the trust ladder — see the "Still pause for" list in `CLAUDE.md`). Use
   `AskUserQuestion` with enough context to answer without scrolling back. Leave the thread
   open until decided.
3. **Skip silently** — only for an event that echoes *your own* comment, or one you already
   handled. Everything else needs a visible outcome.

There is no "note it and move on." If a comment is right but you're not fixing it, say so
in the thread and why.

### 5.4 Verify the claim before you apply the fix

Automated reviewers are frequently right and occasionally confidently wrong. **Read the
code the comment points at before touching it** — including the dependency's source in
`node_modules/` when the claim is about a library's behaviour. Apply a suggestion because you've
confirmed the problem, never because a bot formatted it as a one-click block. A "high
severity" label is not evidence.

When the comment is right, prefer the fix that removes the *class* of problem: reuse the
existing helper/constant rather than authoring a second variant that can drift.

When the comment is wrong, say so in the thread with the specific reason, citing file:line
of whatever you checked — that is a real outcome, not a skip. "Won't fix" with no reasoning
is not settling it. Cosmetic and you're taking it anyway → fold it into the next push
rather than a lone commit; weigh a no-op commit against re-running CI on an already-green
PR.

### 5.5 Verify, then push

The gate applies to review fixes exactly as it does to the original change:

```
pnpm run verify     # lint → typecheck → test
```

A one-line fix still gets the gate — a "trivial" change that reddens CI costs a full extra
round-trip. Never push a review fix that hasn't been verified locally.

An approval you would reset is **never** a reason to hold a fix or ask permission first —
per `CLAUDE.md`'s "Merge automatically on green," losing it is an accepted cost of getting
to green.

### 5.6 Reply, with the commit — then resolve the thread

**Replying is not resolving, and pushing a fix is not resolving.** All three are different
actions: (1) push the fix, (2) reply citing the **commit SHA** so the reviewer can see the
outcome without diffing, (3) call `resolve_review_thread`. Doing 1 and 2 but skipping 3 is
the single most common way this goes wrong — the thread shows the fix sitting right below
it, looks obviously done to a human skimming the page, and still blocks the merge because
nothing ever told GitHub the conversation is over. **This applies regardless of which
workflow led you to the fix** — whether you got there via this skill's own review pass or
via any other PR-activity/webhook-driven fix — if you touched code because of a review
thread, you own driving that specific thread to `is_resolved: true`, in the same turn as
the fix, not "later." Never end a turn that fixed a review finding without either resolving
its thread or stating explicitly why it's left open.

State what changed and why, briefly (or, if you disagreed, say that instead), and end every
GitHub post with:

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

Mechanics — the two IDs are different and easy to mix up:

- `pull_request_read` with `method: "get_review_comments"` returns threads. Each has a
  GraphQL node ID (`PRRT_...`) *and* comments carrying numeric IDs (the `#discussion_r...`
  anchor).
- `add_reply_to_pull_request_comment` takes the **numeric comment ID**.
- `resolve_review_thread` takes the **`PRRT_...` thread node ID**. Passing the numeric one
  fails.

Do this for **every** review thread you addressed, not just the first — Gemini and other
reviewers commonly leave several threads on one PR (e.g. one on the implementation, one on
the corresponding test file). Loop `get_review_comments` → `resolve_review_thread` until
none of your addressed threads remain unresolved.

Then confirm it actually unblocked: `pull_request_read` with `method: "get"` and check
`mergeable_state` flipped from `blocked` to `clean`. Don't assume — that field is the only
thing that tells you whether the merge button is live.

Two things not to do: don't resolve a thread asking a question you haven't answered, and
don't resolve someone's finding just to clear the board. An unresolved thread is a merge
blocker; a wrongly-resolved one is a silently dropped bug.

### 5.7 Keep going until it's actually done

One round is not the task. Re-diagnose and re-push on each new failure until CI is green,
then say so once.

The one legitimate "not mine" outcome: the failure reproduces on the base branch and
predates your change. Say so once in the thread — "CI red on `<check>`, failing on
`main` too, will re-run when it recovers" — and act on the recovery notice when it
arrives. That outcome is still *stated*, never silent.

Merge conflicts are yours to resolve too: merge the base branch into your head (or rebase,
if that's the repo's convention), resolve, verify locally, push. Only escalate when both
sides genuinely changed the same logic and picking one loses behaviour.

Per `CLAUDE.md`'s "Autonomy defaults," once CI is fully green and every review thread is
resolved (`mergeable_state: clean`), merge (squash) without a separate confirmation — that
authorization is standing. It does **not** extend to force-pushes or branch deletions, which
still require explicit sign-off (see the "Still pause for" list).

**"All feedback is addressed" presupposes the required review actually ran — an
unavailable reviewer is a merge blocker, not a green light.** The automated reviewer
(e.g. Gemini Code Assist) posting *"You have reached your daily quota limit"* is **not** a
review with zero findings; it is *no review*. Do not confuse the two. When the required
review has not happened — quota exhausted, the bot errored, or it simply hasn't run yet —
CI-green is necessary but **not sufficient**, and you must **not** merge. Hold the PR: keep
CI green (drive-to-green still applies), but leave it unmerged until the reviewer returns
and posts a real review, or the user explicitly waives the review. This is the one case
where "hold, don't merge" is correct — it is about a *review gate that is unmet*, not about
follow-up work, so it does not contradict the point below. Encode it in the check-in as a
condition to re-test (has a real review posted yet?), never as a permanent hold.

**Readiness is scoped to the PR, not to the issue or epic it advances.** A PR that is a
coherent, CI-green, review-resolved increment is *ready and mergeable now*, even when the
parent issue still has follow-up work — "advances #NNNN" (not "Closes") is exactly that
case. Do **not** hold such a PR waiting to bolt the rest of the work onto it; merge it and
open a follow-up PR for the remainder. Bundling unrelated follow-up work into one
long-lived unmerged PR strands finished, reviewed work and blocks the reviewer.

Two traps to avoid:

- **Don't defer a judgment call you own and then freeze the PR on it.** "Awaiting the
  user's steer on X" is a reason to proceed on your best reasonable default (state it), not
  a reason to withhold an already-finished, unrelated increment from merge. Split the
  undecided part out; ship the decided part.
- **Never bake a "do not merge / WIP" verdict into a recurring `send_later` check-in.** The
  check-in must *re-evaluate* mergeability against the live state each time
  (`get_check_runs` + unresolved threads), not re-assert a stale hold. A prompt that says
  "leave as draft" or "don't merge yet" turns a one-time misjudgement into a
  self-reinforcing loop.
