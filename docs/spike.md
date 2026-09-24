# Week-one spike: can Gemini actually do this?

Everything else in the plan is downstream of one question, so it gets answered first,
before any infrastructure exists:

> Given a real incident and the relevant source, does Gemini produce the patch a human
> actually wrote — and does it decline when the incident isn't worth acting on?

If the answer is no, the rest of the build doesn't matter and we want to know in week one.

## Why fixtures with known outcomes

Each fixture carries **ground truth**: what the correct fix (or the correct decline) is. That
means output can be scored rather than judged on whether it reads plausibly. LLM output
almost always reads plausibly; that is exactly the failure mode this spike exists to catch.

Fixtures live in `fixtures/incidents/*.json`. Each declares what it `measures`:

| measures | The question it answers |
|---|---|
| `fix-quality` | Given a genuine bug, is the proposed patch the right one? |
| `declines-correctly` | Given noise, does it correctly refuse to act? |

Both matter, and the second matters more than it looks. An engine that opens a pull request
for every monitoring blip burns the human review budget that makes the loop viable at all.
Refusing to act is a feature.

## Running it

```bash
cp .env.example .env    # set GOOGLE_CLOUD_PROJECT
pnpm install
pnpm spike
```

For each fixture it prints the triage verdict, the proposed patch (when triage says urgent),
and the ground truth side by side, plus whether triage agreed with reality.

## Reading the results

Triage agreement is scored automatically. **Patch quality is not** — read it yourself and ask:

- Does it identify the same root cause a human did?
- Is it minimal, or did it refactor things nobody asked it to touch?
- When the given context was insufficient, did it say so instead of guessing?

That last one is the real signal. A model that confidently patches a file it cannot see
enough of is more dangerous than one that declines.

## Which fixtures are in this repo

The fixtures committed here are **synthetic but realistic**: bug classes that recur in Firebase
backends, written so their ground truth is unambiguous. The harness runs unchanged over a
private set of real incidents whose real fixes shipped; that set stays private because it
contains another product's source.

## Adding a fixture

For a real-incident fixture, pick an incident whose fix has already merged. Recover the pre-fix source from git history
rather than reconstructing it from memory:

```bash
git show <fix-commit>^:path/to/file.ts
```

Reconstructed "buggy" code quietly makes the task easier than reality — the bug ends up
cleaner and more obvious than it actually was.
