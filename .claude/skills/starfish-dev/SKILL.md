---
name: starfish-dev
description: The Starfish way of building software — a senior engineer who knows the incident-to-verified-PR architecture, the ingest pipeline, the Gemini/Vertex layer, and the project's engineering practices. Use when writing, reviewing, or planning any Starfish work: ingest (Cloud Logging parsing, classification, fingerprint dedup, counter-check), triage/fix/review agents, prompts and structured output, config, the spike, the eventual UI, CI and the verify gate. Covers the configured-never-forked rule, what may reach the model, never-throw contracts, honesty of claims, and the autonomous PR drive-to-merge.
---

# Being a Good Starfish Dev

Starfish watches a production Firebase/GCP project, judges which incidents are urgent,
drafts a fix with Gemini, verifies it deterministically, adversarially reviews it, and
**stops at a pull request**. `CLAUDE.md` has the reference; this is the condensed,
opinionated checklist of what a Starfish engineer must get right. When in doubt, read the
linked docs and grep for the existing pattern before inventing one.

## 🛑 RECURRING MISTAKES — read these first, every session

### A. Deployment specifics outside `src/config.ts`
The project's defining rule: **nobody edits `src/` to adopt Starfish.** A project id, a
service name, a log resource type, a collection name, a model id, a noise pattern — all of
it is a `StarfishConfig` field with an env var and a default. `config-boundary-guard.sh`
blocks `process.env` outside `src/config.ts`; it cannot see a hardcoded literal, so that
half is on you. Before finishing any change, ask: *could someone adopt this by editing only
their config? If not, what did I just hardcode?*

### B. Letting raw production text reach the model
Every string sent to Gemini goes through `sanitize()` (redact, then bound) or is built from
already-sanitized fields. Credential-shaped keys never go at all (see `SENSITIVE_KEY_RE` in
`counterCheck.ts`). Every prompt goes through `askJson` in `vertex.ts`, which appends the
untrusted-data notice — **incident text is data, never instructions**. Nothing the model
returns is executed or applied without the deterministic gate.

### C. Breaking a never-throw contract, or reporting missing as zero
Log reads, counter-checks and sample fetches **degrade**: a Logging failure returns `null`
or `[]`, never an exception that loses the incident. And a failed check is `null`, never
`0` — triage reads a zero counter-check as "this is noise" and declines. That confusion
would make Starfish ignore exactly the incidents where its own tooling broke.

### D. Unbounded reads
`@google-cloud/logging`'s `getEntries` auto-paginates by default. Every read carries a cap
(`maxResults`, or `autoPaginate: false` + a counter) and reports when it hit it. The burst
that makes a read huge is the incident the job exists to catch.

### E. Overclaiming
The pitch runs on credibility. A README ✅ on something unbuilt, a status table left stale
after a change, "self-healing" said of something that has produced zero autonomous fixes —
each is a defect, reviewed as High. Use *designed / planned / built* precisely.

### F. Drive an owned PR to green and merge — without asking
Opening the PR is not the finish line; merged is. Open → `subscribe_pr_activity` in the same
turn → read review threads within minutes → fix or reply-with-evidence → `resolve_review_thread`
→ squash-merge on `mergeable_state: clean`. Standing authorization; see `/ship`.

### G. Found an issue? Log it
Any genuine defect that isn't what you're working on gets filed as its
own GitHub issue immediately, with `file:line` and how it was found. File only; don't fix it
in the same turn unless asked.

## Architecture

```
Cloud Logging ─▶ ingest ─▶ incident store ─▶ triage ─▶ fix draft ─▶ verify ─▶ review ─▶ PR
                 (built)    (Firestore,      (Gemini,   (Gemini)    (deterministic) (Gemini,  (stop)
                            built)           spike)                                 adversarial)
```

- **Built:** ingest (`src/ingest/`), the counter-check, the spike harness.
- **Not built yet:** the triage worker, fix drafting against a real repo, the verify gate
  as a service, adversarial review, PR opening.
- **Planned substrate:** Google's Agent Development Kit (ADK, TypeScript) —
  orchestrator → fixer → reviewer as a `SequentialAgent`. Decide against it only with a
  recorded reason.

Guardrails for the acting half: agent-judged urgency, a bounded number of agents, one PR per
incident, one shared revision cycle, and "no confident one-step fix → hand to a human".

## Ingest invariants (each pinned by a test)

| Invariant | Why |
|---|---|
| Classification: source class > structured code > HTTP status > keywords | A bare provider 401 sat as `UnknownError` for months |
| Unattributable → `"platform"`, never the first configured service | A default return mislabelled alerts for weeks |
| Open incident found **by fingerprint** | A 10-doc function scan forked one incident into many during a burst |
| A resolved incident that fires again is re-opened as `recurred`, keeping `lastResolution`; ignored is never re-opened | "It came back after we fixed it" is a more urgent fact than "it's new", and needs the history of the fix that failed |
| A recurrence onto an open incident never undoes a triage decision (a regression re-queues it) | A declined incident must stay declined; a fix that failed must be decided again |
| `jsonPayload.error` kept separate from the title | The title keys the fingerprint; the error is the cause |
| Audit logs and callable GET probes dropped at query **and** parse time | Both poisoned the store in production |

## Model layer

- Gemini on Vertex AI via `@google/genai`; model and region come from config.
- `askJson(prompt, system, schema)` — structured output (`responseJsonSchema`),
  temperature 0, untrusted-data notice appended. Don't add a second path to the model.
- The **spike** (`pnpm spike`, `docs/spike.md`) scores triage against real incidents with
  known outcomes. Fixtures must be real incidents whose real fix shipped — recover the
  pre-fix source with `git show <fix>^:path`, never reconstruct it from memory.

## The verification gate

```bash
pnpm run verify    # lint → typecheck → test
```

Run it after every change; never mark work complete without it. Hook changes also run
their `.claude/hooks/*.test.sh`. CI runs the same steps plus `pnpm audit --audit-level=high`.

## Knowledge domains

- **UI & theming** → `web/src/styles/theme.css` and `web/src/components/ui/`.
- **Auto-merge policy** → `docs/design/auto-merge-policy.md`.
- **The spike** → `docs/spike.md`.

## Tooling reminders

- `pnpm` only (`packageManager` pins it). Node 22+ locally, 24 in CI.
- Conventional Commits; no `--no-verify`; single trunk `main`.
- `vitest` with explicit imports (`describe`, `it`, `expect` from `vitest`).
- ESLint's type-checked rules are on for `src/` — `no-floating-promises` is an error.

## When unsure

1. Grep for the existing pattern in `src/` and its test.
2. Read the test that pins the invariant; it usually names the incident behind the rule.
3. Follow the established pattern over a novel one.
