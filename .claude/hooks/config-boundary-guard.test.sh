#!/usr/bin/env bash
# Table-driven tests for config-boundary-guard.sh.
# Run: bash .claude/hooks/config-boundary-guard.test.sh

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/config-boundary-guard.sh"
pass=0
fail=0

# <expected: allow|deny> | <tool: write|edit> | <path> | <added text>
run_case() {
  local expected="$1" tool="$2" path="$3" text="$4" out decision
  if [ "$tool" = write ]; then
    out="$(jq -n --arg p "$path" --arg t "$text" '{tool_input:{file_path:$p,content:$t}}' | bash "$HOOK")"
  else
    out="$(jq -n --arg p "$path" --arg t "$text" '{tool_input:{file_path:$p,old_string:"x",new_string:$t}}' | bash "$HOOK")"
  fi
  decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null)"
  [ -z "$decision" ] && decision=allow
  if [ "$decision" = "$expected" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: expected=$expected got=$decision tool=$tool path=$path text: $text"
  fi
}

# Engine code reading the environment directly
run_case deny  edit  /repo/src/vertex.ts            'const m = process.env.STARFISH_MODEL ?? "x";'
run_case deny  write /repo/src/ingest/aggregate.ts  'const p = process.env["GOOGLE_CLOUD_PROJECT"];'
run_case deny  edit  /repo/src/spike.ts             'const { STARFISH_ENV } = process.env;'
run_case deny  edit  src/triage.ts                  'if (process.env.DEBUG) log(x);'

run_case deny  edit  /repo/src/vertex.ts            'if (process.env?.DEBUG) log(x);'
run_case deny  edit  /repo/src/vertex.ts            'const e = process["env"];'
run_case deny  write /repo/src/ui/App.tsx           'const url = process.env.API_URL;'
run_case deny  write /repo/src/x.mts                'export const p = process.env.P;'

# Prose in comments is not a read
run_case allow edit  /repo/src/vertex.ts            '// resolved from process.env in config.ts'
run_case allow edit  /repo/src/vertex.ts            $' * Reads nothing from process.env (see config.ts).'
# ...but code after a URL in a string still is
run_case deny  edit  /repo/src/vertex.ts            'const u = "https://x"; const p = process.env.P;'

# The one place it belongs
run_case allow edit  /repo/src/config.ts            'model: process.env.STARFISH_MODEL ?? "x",'
# Tests may set up the environment
run_case allow edit  /repo/src/ingest/store.test.ts 'process.env.GOOGLE_CLOUD_PROJECT = "p";'
# Outside src/ (scripts, hooks, docs) is not engine code
run_case allow write /repo/scripts/verify-gate.mjs  'const ci = process.env.CI;'
run_case allow write /repo/docs/notes.md            'Set process.env.STARFISH_MODEL'
# Engine code that takes config is fine
run_case allow edit  /repo/src/vertex.ts            'const { model } = loadConfig();'
# A word that merely contains the substring
run_case allow edit  /repo/src/x.ts                 'const processEnvelope = 1;'

echo ""
echo "config-boundary-guard tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
