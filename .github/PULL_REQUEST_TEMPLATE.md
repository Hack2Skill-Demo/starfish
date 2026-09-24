# Summary
What does this change do? (One line, then why.)

## Closes
<!-- Every issue this PR resolves, one per line, keyword directly before the #.
     GitHub auto-closes on merge only in this exact form: -->
<!-- Closes #123 -->

## Test plan
- [ ] `pnpm run verify` green (lint · typecheck · test)
- [ ] New behaviour has a test that fails without the change
- [ ] Hook changes: the `.claude/hooks/*.test.sh` suites pass

## Starfish checks
- [ ] **Configured, never forked** — nothing deployment-specific outside `src/config.ts`
      (new settings added to `.env.example` with a default)
- [ ] **Text to the model is redacted and bounded**, and treated as untrusted data
- [ ] **Never-throw contracts hold** — a failing log read or model call degrades, it
      doesn't lose the incident
- [ ] **Honesty** — docs and README claim nothing the code doesn't do yet

## Risk & rollback
What can go wrong, and how to back it out.
