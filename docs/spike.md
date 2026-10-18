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

For each fixture it prints the triage decision, the proposed patch (when triage chose `act`, a code fix),
and the ground truth side by side, plus whether triage agreed with reality ("urgent" is `act`).

Since #420 it asks through the agent's own stages (`triageIncident`, `proposeFix`), so it shows the model the same
prompts, bounds and redaction the agent does and gets back the same normalized patch. It used to carry prompts of its
own, which had drifted from the agent's. The admin's merge cases and class rules are not applied: the spike reads no
runtime settings.

## Running a patch, not reading it (#4)

A `fix-quality` fixture may carry a `checkout` (`src/types.ts`): the pre-fix source as a directory, the files the model
is shown in full, the target's own verify command, and a private evaluator (a directory outside the source plus a
command). For such a fixture the spike, through the verify gate (`src/scoreboard/evaluate.ts`):

1. runs the evaluator on a disposable copy of the unpatched source, and refuses the fixture unless it **fails** there
   (the defect reproduces);
2. applies the patch the fixer stage returns (`git apply`), which is the model's diff with its hunks placed by
   `normalizePatch` exactly as the agent places them (nothing is repaired by hand), and requires the target's command
   **and** the evaluator to pass. A patch that touches an evaluator file is refused.

An empty patch on a fix case, a diff that does not apply, a timeout or a failing command is a FAIL, and makes
`pnpm spike` exit 1; so does a patch on a `declines-correctly` fixture. Each check prints its status, rule, exit code and
the patch hash. A fixture with no checkout prints `NOT CHECKED`: a plausible diff is not a pass. Running a model's patch
is running code in this process, so the patch check needs `STARFISH_VERIFY_ISOLATION=in-process`, said on purpose;
without it the check is `NOT RUN` and fails.

**Built, and tested only through its parts with synthetic data; never run against Vertex.** The two fixtures in
`fixtures/incidents/` have no checkout, so today the spike still checks no patch. What #4 still needs, and only a person
with Vertex access can do: grow the fixtures to at least 5 `fix-quality` (each with a checkout whose source is recovered
from history, as below) and 3 `declines-correctly`; commit the code-fix class, fixture ids and decision rule before the
first scored run; run `pnpm spike`; and record the raw outcomes and a go/no-go here. No such run has happened, and this
page reports no result.

## Reading the results

Triage agreement is scored automatically, and so is a patch with a checkout (above). **Patch quality beyond passing is
not** — read it yourself and ask:

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
