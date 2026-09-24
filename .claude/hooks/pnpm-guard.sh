#!/usr/bin/env bash
# PreToolUse(Bash) guard: enforce pnpm in this pnpm project.
# ============================================================================
# CLAUDE.md: "Always use pnpm. Using npm will break dependency linking."
# Blocks npm / npx / yarn and points at the pnpm equivalent. Deterministic,
# instant, zero false positives (these binaries are simply wrong in this repo).
#
# Reads the tool-call JSON on stdin; emits a PreToolUse deny when it catches a
# forbidden package manager. Inspects the first token of EACH &&/;/|-separated
# segment, so `something && npm install` is caught too.

set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"

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

[ -z "$cmd" ] && allow

# Strip quoted strings (double, single, backtick) first, so operators or the
# word "npm" inside a commit message / argument can't create false segments or
# false positives — e.g. git commit -m "fix; npm was failing, use pnpm".
# Double-quote / backtick patterns also consume backslash-escaped chars
# (\" \`), so an escaped quote doesn't terminate the strip early. Single
# quotes don't honor backslash escapes in the shell, so a plain class is fine.
# tr newlines→\r first so sed (line-based) treats a multi-line quoted string as
# one line and strips it whole; restore newlines afterward. Without this a line
# like "npm ..." inside a multi-line commit message would survive and false-positive.
clean_cmd="$(printf '%s' "$cmd" | tr '\n' '\r' \
  | sed -E 's/"([^"\\]|\\.)*"//g' \
  | sed -E "s/'[^']*'//g" \
  | sed -E 's/`([^`\\]|\\.)*`//g' \
  | tr '\r' '\n')"
# Split the command into segments on && || ; | & and inspect each first token.
segments="$(printf '%s' "$clean_cmd" | sed -E 's/(\|\||&&|[;|&])/\n/g')"
while IFS= read -r seg; do
  seg="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//')"
  first_tok="${seg%%[[:space:]]*}"
  case "$first_tok" in
    npm)
      deny "BLOCKED: use pnpm, not npm — npm ignores pnpm-lock.yaml and writes a second lockfile (CLAUDE.md). Swap the binary: 'npm install' → 'pnpm install', 'npm run build' → 'pnpm run build', 'npm ci' → 'pnpm install --frozen-lockfile'." ;;
    npx)
      deny "BLOCKED: don't use npx in this pnpm workspace. Use 'pnpm exec <bin>' for a local binary (npx jest → pnpm exec jest) or 'pnpm dlx <pkg>' for a one-off (npx create-x → pnpm dlx create-x)." ;;
    yarn)
      deny "BLOCKED: this repo uses pnpm, not yarn. Use the pnpm equivalent: 'yarn add X' → 'pnpm add X', 'yarn' → 'pnpm install'." ;;
  esac
done <<EOF
$segments
EOF

allow
