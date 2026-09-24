#!/usr/bin/env bash
# PreToolUse(Edit|Write) guard: keep deployment specifics in src/config.ts.
# ============================================================================
# Starfish's standing goal (README): "Nobody should have to edit
# src/ to run Starfish against their own project." Everything deployment-
# specific belongs in src/config.ts. The one mechanical symptom of breaking
# that is reading the environment somewhere else — a module that reads
# process.env has quietly grown its own config surface that loadConfig() can't
# see, document, or validate.
#
# This is the project's own CRITICAL rule, caught at the moment it would be written rather
# than in review.
#
# Scope: only the ADDED text (Write.content / Edit.new_string) of TypeScript
# under src/, excluding src/config.ts and tests. Scanning added text means an
# unrelated edit to a file never trips on pre-existing code.
#
# Reads the tool-call JSON on stdin; emits a PreToolUse deny with the fix.

set -euo pipefail

input="$(cat)"
path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
added="$(printf '%s' "$input" | jq -r '.tool_input.content // .tool_input.new_string // ""')"

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

allow() { exit 0; }

[ -z "$path" ] && allow
[ -z "$added" ] && allow

case "$path" in
  */src/*.ts|src/*.ts|*/src/*.tsx|src/*.tsx|*/src/*.mts|src/*.mts|*/src/*.cts|src/*.cts) ;;
  *) allow ;;
esac
case "$path" in
  */src/config.ts|src/config.ts) allow ;;
  *.test.ts|*.test.tsx) allow ;;
esac

# Drop // line comments and * block-comment lines first, so prose that merely
# names process.env ("see process.env") isn't read as a read of it.
code="$(printf '%s' "$added" | sed -E -e 's#(^|[^:])//.*$#\1#' -e '/^[[:space:]]*\*/d')"

# process.env.X, process.env?.X, process.env["X"], process["env"], or
# destructuring / aliasing process.env.
if printf '%s' "$code" | grep -Eq 'process(\?)?\.env([.?[]|[[:space:]]*[;,)}]|$)|process\[|=[[:space:]]*process\.env\b'; then
  deny "BLOCKED: process.env read outside src/config.ts. Starfish's rule is that nobody edits src/ to adopt it — every deployment-specific value is a StarfishConfig field. Add the field (with its env var and default) to src/config.ts and .env.example, then take it from loadConfig() / a StarfishConfig parameter here. (CLAUDE.md: configured, never forked)"
fi

allow
