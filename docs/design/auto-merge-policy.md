# Auto-merge policy: merge what it can prove, escalate the rest

> **Status: decided, not built yet.** Today Starfish stops at a pull request. Auto-merge is
> planned for the demo project first, where the public can watch a fix merge, deploy and heal.
> Production targets stay PR-only until the replay evidence below justifies more.

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
| **Missing composite index** | Additive; can't grant access or break a read | Google's error names the exact index | **Auto-fix, auto-merge, auto-deploy** (below) |
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

### Design sketch (not built)

1. **Classify** `FAILED_PRECONDITION` "requires an index" incidents as their own class. This
   depends on keeping `jsonPayload.error` intact, separate from the title: it's where the
   create-index URL lives.
2. **Parse** the URL into an index spec: collection group, fields, order, query scope.
3. **Dedupe** against the project's index file; flag array-field indexes.
4. **Create** the index with one Admin API call; wait for READY; re-run the failing query.
5. **Open and auto-merge** a PR adding the same entry to the index file, in whichever repo
   owns the indexes, which is not always the repo that owns the query.
6. Ship behind a `dryRun` config flag first.

## Configuration surface (planned)

Starfish connects three systems, configured on a settings page:

- **Gemini** (Vertex AI project, region, model)
- **GitHub** (repos, which repo owns indexes and rules, branch, labels)
- **Slack** (channels for notify / escalate / healed)

It also exposes the **rules engine** (the class table above, per project) and the **feedback
engine** (reclassification history).

GitHub and Slack integration and the settings page are designed; the settings page exists but
only describes the connections today.

## Before auto-merge is turned on for a target

- **Fast-revert built**, as above.
- **Replay evidence.** Replaying real incident history gives a measured score for each class,
  and a class auto-merges only once its score justifies it.
- **An explicit per-target switch**, off by default, owned by an admin.

## Sources

- [Manage indexes in Cloud Firestore](https://firebase.google.com/docs/firestore/query-data/indexing)
- [Enterprise edition index overview](https://docs.cloud.google.com/firestore/native/docs/enterprise-index-overview)
- [Firebase MCP server](https://github.com/firebase/firebase-tools/blob/main/src/mcp/README.md)
- [Firebase MCP Server GA + Gemini CLI extension](https://firebase.blog/posts/2025/10/firebase-mcp-server-ga/)
- [Rules Playground](https://firebase.google.com/docs/rules/simulator) ·
  [Rules unit tests](https://firebase.google.com/docs/rules/unit-tests) ·
  [Fix insecure rules](https://firebase.google.com/docs/firestore/security/insecure-rules)
