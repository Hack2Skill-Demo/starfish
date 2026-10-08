# Auto-merge policy: merge what it can prove, escalate the rest

> **Status: built for the demo target behind a default-off switch (#9); other targets stay
> PR-only. Never run against real GitHub.** Code-fix auto-merge and fast-revert are written and
> tested against real git, a fake GitHub API and the Firestore emulator. A target can auto-merge
> only if the deployment lists it in `STARFISH_AUTO_MERGE_TARGETS` (the demo) **and** an admin
> turns `autoMerge` on in Settings; every other target stays PR-only even if the switch is turned
> on by mistake. Starfish never deploys: the target's own CI/CD does. The index path (#11) is
> separate and not covered by this switch. "As built" below says exactly what runs and what does
> not; production targets stay PR-only until the replay evidence below justifies more.

## As built (#9)

**Where it runs.** The agent loop (`src/agent/loop.ts`) prepares; the agent pass merges.

1. *In the cycle*, only when the merge switches allow it right now: gate 1 runs on the proposed
   patch (`src/agent/blastRadius.ts`). When it passes, the patch's **test files alone** are run on
   the base revision through the same verifier the patch uses, and the result is recorded as
   `summary.before`. When the pull request opens, the cycle records an auto-merge candidate
   (`summary.merge`: gate 1's result, the patch hash, the head commit the opener built, whether
   the incident's stack trace names the changed file). A candidate that fails gate 1 is handed to
   a person at once.
2. *After each agent pass* (`src/agent/autoMerge.ts`), each candidate is taken to merged or to a
   person: the switches and the incident's status read fresh; gate 1 as recorded; gate 2 over the
   run record (`certaintyGate`, a pure function); the PR still open, from `starfish/<cycle>` into
   the configured base branch (a PR retargeted elsewhere goes to a person), with the head Starfish
   built; every run of every named required check (`STARFISH_VERIFY_CHECKS`) posted by
   `STARFISH_VERIFY_CHECK_APP` (default `github-actions`; a same-named run from any other GitHub
   App is ignored, but the slug does not tell workflows apart: every workflow in the target
   repository posts as `github-actions`) a success on that head, all runs read (`filter=all`, every
   page up to a bound; more than that goes to a person), so a later success never hides a failure
   (still running: it waits, at most `STARFISH_MERGE_CHECK_WAIT_MINUTES`); a claim and today's
   merge count in one transaction (`STARFISH_MAX_MERGES_PER_DAY`, default 3); the switches and
   status once more; the evidence posted on the PR as one comment; then one squash merge with
   GitHub told the exact head (`sha`), so a head that moved refuses. Any failure leaves the PR open
   and tells a person (the loop's notify path). A merge interrupted half-way is never retried: the
   next pass reads the PR back and records what happened, or hands it to a person.
3. *The fast-revert watch* (`src/agent/fastRevert.ts`) starts at every merge: see below.

**The switches.** `autoMerge` (per target: the deployment's one `githubRepo`; runtime setting,
default off), `mergeFreeze` (the global off switch for merging and reverting; runtime setting,
default off), the automation kill switch, `dryRun` (on ⇒ nothing merges), and the environment-only
allowlist `STARFISH_AUTO_MERGE_TARGETS`. Turning a switch on is a Settings save, which is audited
like every other. Nothing merges while any switch says no; a test pins that a non-demo target, or
the switch off, never prepares or merges anything.

**Gate 1 as built.** A plain diff whose `---`/`+++` paths are in git's `a/`/`b/` form and name the
same file on both sides and in the `diff --git` line (no rename, copy, delete, mode change or
binary, no `.`/`..` path segment), so the file gate 1 reads is the file `git apply` writes; and the
loop then requires gate 1's files to be exactly the files the verify gate saw the patch change. No
control character anywhere in the patch or the changed file's base content other than a tab and
the line ends: no lone carriage return, no Unicode line or paragraph separator, no zero-width or
bidirectional mark, because JavaScript ends a line where a reader of the diff does not
(`// note<CR>return;` is a comment in the diff and a `return` to the test runner). A
`\ No newline at end of file` marker only after a side's last line at the file's end: anywhere else
git joins that line onto the next and writes one line where the diff shows two. One production
file, an existing JavaScript/TypeScript file, one hunk with at least three lines of context on each
side (fewer only at the file's start or end), no function or class boundary between the first and
last changed line, at most 8 lines added and 4 removed. Every other file must be a **new** test file
(`--- /dev/null`, named `*.test.*` or `*.spec.*`, outside `__mocks__` and `__snapshots__`) made only
of added lines: **tests come only as new files, and a test file that already exists is never
changed.** A removed line can disable the test that judges the patch, and so can an added one (a
block comment, an early `return;`, `.skip`, a matcher re-defined with `expect.extend`, a spy, a
global changed at collection time); that list cannot be completed, so no change to an existing test
file is allowed. What this cannot stop: a new test file that changes state other tests share, or,
where the target's runner runs every test file in one process, one that ends that process early
("fails before" only shows the new test failing without the fix). Every
changed block one class: *null guard* (an early `return;`, `return null`, `return undefined` or
`throw` when a value is null or undefined, said explicitly: `x == null`, `x === null`,
`x === undefined`, `x == undefined`, `typeof x === "undefined"`, or `||` of those; never `!x`, which
is also true for 0, `""`, `false` and `NaN`, and never `return true` or another value, which is a
change to what the function decides; the guard ended by its own `;` or a block, so JavaScript cannot
join the next line onto its `return`; or `?.`/`?? null`/`?? undefined` added to an otherwise unchanged
line, the default ending its expression (not `a ?? null + b`) and never on a line that compares or does
arithmetic, where null and undefined differ; any other default, `?? 0` or `?? true`, is a value the code
then decides on wherever it lands),
*missing `await`* (`await ` added to an otherwise unchanged call), *Firestore `undefined` field*
(`key: v` becomes `...(v !== undefined && { key: v })` or `key: v ?? null`, `v` a plain reference, never a call). The hard-exclude list
matches path words (access control includes owner, guard, policy, App Check, verify and can) and
changed lines: auth and access control, security rules, money paths, secrets and crypto, schema,
dependencies and lockfiles (and any import or require), CI and deploy config, shared packages, plus
`STARFISH_PATCH_EXCLUDED_PATHS` and `STARFISH_AUTO_MERGE_EXCLUDED_PATHS`. Access control, money and
secrets are also matched on every statement that decides something (a comparison, a condition, a
`return` or a `throw`) in the **whole enclosing function as the base revision has it**, not only in
the context lines the patch's author chose to show: a guard anywhere above an ownership check
changes that check. The loop reads the changed file from its checkout of the base revision (no
symbolic link, within a size cap); gate 1 refuses when that content is missing or does not hold the
hunk's lines. The function is found with a scanner, not a parser (strings, templates, comments and
regular expressions skipped; the top-level statement around the change, so a class method is judged
with its whole class); when it cannot read the file for certain, the whole file is judged. It is a
word match, not a proof. Unsure is never allowed.

**Gate 2 as built.** All five from the run record: (1) structural cause: triage decided `act`, the
fixer proposed, and the incident's own stack trace names the changed file, matched against the
checkout's whole file list as the pass matches it, so a frame of another file with the same tail
does not count (a keyword match is not enough, and an error code alone does not tie the cause to a
file); (2) **fails before, passes
after**: the fixer added a test, the test-only run *failed* for this exact patch hash, and (3) the
full patch *passed* the verify gate, on the same hash as the PR; (4) the adversarial review
approved that hash with zero attacks broken and zero flagged (no review, as with
`STARFISH_REVIEW_REQUIRED=false`, fails it); (5) the counter-check counted more than zero (missing
fails it). The full verify gate being green on the target's CI is checked on the PR's head itself.

**What "fails before" can and cannot show.** It is the verify command failing with only the
patch's tests applied. With `github-actions` isolation that is the target's CI failing on a
test-only commit pushed to `starfish/<cycle>` (deleted afterwards); with `cloud-run-job` and
`in-process` it is the same command. It cannot tell a failing assertion from a test that does not
compile or a flaky one. A patch with no test file cannot show it, and so never auto-merges.

**Fast-revert as built.** Every merge starts a watch. The incident has come back when it is seen
again later than `STARFISH_FAST_REVERT_GRACE_MINUTES` (10) after the merge and within
`STARFISH_FAST_REVERT_MINUTES` (60) of it: its last occurrence in the window, a regression the
ingest marked `recurred`, or an hour of its occurrence series that starts after the grace and no
later than the window's end (for a window that holds no hour boundary, the first hour after the
grace). The store counts each ingest window in the hour of its latest occurrence, so such an hour
always holds an occurrence after the grace, never a late-ingested one from before the merge, and an
error that keeps firing past the window is still seen, whenever the hourly pass reads it. The price:
a recurrence can be counted from up to an hour past the window's end (two, for a window with no
hour boundary); and an ingest window longer than an hour (a catch-up after an ingest outage) counts
all its occurrences in its last hour, which can lie past the hours that count, so that recurrence is
missed. A watch that saw nothing is cleared a settle hour (for late ingestion) after the last hour
that counts has ended. On a recurrence Starfish tells a person, opens a revert of its own merge
commit on `starfish/revert-<cycle>`, and merges it once its required checks pass. It escalates
instead when a later commit on the base branch touched a file the merge touched, when the merge
does not revert cleanly, when the revert PR was retargeted to another base branch, or when a switch
forbids merging. A
revert is never itself watched, so never reverted; a retired incident never triggers one; an
incident Starfish already reverted for is not auto-merged again. Reverts do not count against the
daily cap.

**Not built, and said so.** The window starts at the **merge**, not at deployment completion:
Starfish cannot observe the target's deploy yet, so the grace stands in for it (#9 keeps "start at
deployment completion" open). Nothing confirms the revert deployed. Nothing marks an incident
healed. Fault rotation is not paused during the watch (#5). Replay evidence per class (#10) has not
gated the classes yet. The Gemini spend cap per day is the existing daily cycle cap, not a token
budget.

## Positioning

Starfish is positioned on **productivity**: it finishes the job instead of handing every fix
back to a human. The line it holds is:

> **Starfish merges the fixes it can prove are safe, and escalates everything else, as a
> verified PR or a Slack message saying exactly what to do.**

This replaces the earlier framing of a tool that is "never allowed to merge". The trust
ladder still exists; it is now the explanation of *which* fixes may merge, not a promise that
none will.

## The rule: two gates, both required, every time

An automatic merge happens only when **both** gates pass. They are checks the system runs,
never the model's confidence in itself.

**Gate 1: low blast radius.** A static check on the diff.
- The change falls entirely inside one class the rules engine allows (see below).
- It touches nothing on the hard-exclude list, whatever the tests say: auth or access
  control, security rules, money paths, crypto and secrets, schema, shared packages, or more
  than one function.

**Gate 2: certainty.** Evidence; all five must hold.
1. The cause comes from **structure, not guesswork**: a structured error code, or a fix
   Google itself specifies (the create-index URL), not a keyword match on message text.
2. The failure **reproduces before the fix and passes after it** (a test or a re-run query).
3. The full **verify gate is green**.
4. The **adversarial reviewer** finds nothing blocking.
5. The **counter-check confirms the incident is real** (not zero), so noise is never "fixed".

If either gate fails, Starfish falls back to opening the PR and stopping.

**The mandatory safety net: fast-revert.** If the same fingerprint recurs within N minutes of
the fix going live, a revert PR opens automatically, and a revert is never itself reverted by
the bot. Auto-merge does not ship without it.

## Classes, and what each is allowed to do

This table is the first version of the **rules engine**: incident class → required evidence
→ allowed action.

| Class | Blast radius | Certainty source | Allowed action |
|---|---|---|---|
| **Missing composite index** | Additive; can't grant access or break a read | Google's error names the exact index | **Auto-fix, auto-merge, auto-deploy** (below). For the MVP the index is created by one Admin API call and its evidence PR is left for a human to merge: index-PR auto-merge is deferred (#11) |
| Null/undefined guard, missing `await`, a Firestore `undefined` field | One function's handler | Stack trace, plus a test failing before the fix | **Auto-merge**; deploy stays with a human for now |
| Security rules | Widens access; a wrong fix is a data leak | A denial is often the rule working correctly | **Draft PR only**, with an emulator test showing who gains access. A human approves. |
| Config / infrastructure (e.g. an API not enabled) | Not code | A patch can't fix it | **Notify** in Slack with the exact console step |
| Noise (counter-check reads 0) | — | — | **Decline** and record why |

The **feedback engine** is how this table gets corrected. When a human reclassifies an
incident, for example one wrongly treated as a hotfix, the correction becomes a rule override
and a replay test case. An auto-merge class widens only when the replay score earns it.

## Missing indexes: why they can heal end to end

Missing composite indexes are common in Firebase projects for a structural reason. The query
ships in application code, while the index that makes it work is a separate file, deployed
separately and often by another team. Teams end up writing their own pre-deploy coverage
checks just to fight this drift.

### What Google already offers, and the gap

| Google provides | What it does | What it leaves open |
|---|---|---|
| Create-index link in the `FAILED_PRECONDITION` error | Opens the console with the exact index filled in | A human has to click. The console change isn't in the repo's index file, so the two drift. |
| Firebase CLI / Terraform | Indexes as code, deployed from `firestore.indexes.json` | Someone has to write the entry. Deploying a stale file can remove console-created indexes. |
| Firestore Enterprise edition | Indexes optional: an unindexed query runs as a scan (Query Explain, `forceIndex`) | Standard edition only, and it trades the error for scan cost |
| Firebase MCP server | Reads and syntax-checks security rules | Nothing for indexes; deploys nothing |

Every one of these is an authoring aid or a click a human makes. Nothing takes a production
failure all the way to a committed, deployed fix. That gap is Starfish's.

### Worst cases, and the guardrail for each

An index cannot grant access: rules are evaluated independently of indexes. So the worst cases
are operational, not security:

| Worst case | Guardrail |
|---|---|
| **Deploying the index file deletes other indexes.** A stale `firestore.indexes.json` deployed with `firebase deploy` can remove indexes created in the console, breaking queries that worked. This is the one genuinely dangerous failure, and it comes from *how* you deploy. | **Never deploy by file.** Create the single index with one Admin API call, then PR the same entry into the index file. Nothing is ever deleted. |
| The wrong index is created | **No LLM in the fix path.** Parse the spec deterministically from Google's create-index URL. Gemini classifies the incident and writes the PR/Slack explanation; it never writes the index. |
| Cost and write amplification | Only the one index the error asked for; dedupe against existing indexes; report the new index's cost in Slack. |
| Hitting the per-database composite index limit | Cap additions per day; alert as the database nears the limit. |
| Long build on a large collection | "Healed" only when the index reports READY, the same query succeeds, and the fingerprint stops recurring. |
| Per-document index-entry limit (large array fields) can make writes fail | Array-field indexes go to a human; auto-heal plain field indexes only. |

### Design sketch (built in code for the MVP, never run against Google: README, #11)

1. **Classify** `FAILED_PRECONDITION` "requires an index" incidents as their own class. This
   depends on keeping `jsonPayload.error` intact, separate from the title: it's where the
   create-index URL lives.
2. **Parse** the URL into an index spec: collection group, fields, order, query scope.
3. **Dedupe** against the project's index file; flag array-field indexes.
4. **Create** the index with one Admin API call; wait for READY; re-run the failing query. The query
   is not in the create-index URL, so it is configured (a deterministic probe), never guessed.
5. **Open** a PR adding the same entry to the index file, in whichever repo owns the indexes, which
   is not always the repo that owns the query. For the MVP a person merges it; auto-merging the
   index PR is deferred, and "healed" is recorded separately from the PR (runtime healed, PR pending).
6. Ship behind a `dryRun` config flag first.

## Configuration surface (planned; the merge switches are built, above)

Starfish connects three systems, configured on a settings page:

- **Gemini** (Vertex AI project, region, model)
- **GitHub** (repos, which repo owns indexes and rules, branch, labels)
- **Slack** (channels for notify / escalate / healed)

It also exposes the **rules engine** (the class table above, per project) and the **feedback
engine** (reclassification history).

GitHub and Slack integration and the settings page are designed; the settings page exists but
only describes the connections today.

## Before auto-merge is turned on for a target

- **Fast-revert built**, as above (built for the demo target, #9).
- **Replay evidence.** Replaying real incident history gives a measured score for each class,
  and a class auto-merges only once its score justifies it.
- **An explicit per-target switch**, off by default, owned by an admin (built: `autoMerge` plus the
  environment's `STARFISH_AUTO_MERGE_TARGETS`).

## Sources

- [Manage indexes in Cloud Firestore](https://firebase.google.com/docs/firestore/query-data/indexing)
- [Enterprise edition index overview](https://docs.cloud.google.com/firestore/native/docs/enterprise-index-overview)
- [Firebase MCP server](https://github.com/firebase/firebase-tools/blob/main/src/mcp/README.md)
- [Firebase MCP Server GA + Gemini CLI extension](https://firebase.blog/posts/2025/10/firebase-mcp-server-ga/)
- [Rules Playground](https://firebase.google.com/docs/rules/simulator) ·
  [Rules unit tests](https://firebase.google.com/docs/rules/unit-tests) ·
  [Fix insecure rules](https://firebase.google.com/docs/firestore/security/insecure-rules)
