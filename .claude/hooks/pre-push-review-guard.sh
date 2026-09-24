#!/usr/bin/env bash
# PreToolUse(Bash) gate: run a Starfish code review BEFORE any `git push`.
#
# Hosted PR reviewers proved unreliable (quota), so review happens locally via the /starfish-code-review skill. This
# hook makes that automatic: it DENIES a push until a fresh local review has
# been recorded, which prompts the agent to run the review on the local diff.
#
# "Fresh" = the marker file $(git rev-parse --git-path starfish-review-ok) exists
# AND its mtime is newer than (or equal to) the latest commit. So a new commit
# after a review invalidates the marker and forces a re-review of the new
# diff. The marker lives inside the repo's git-dir, which is never committed.
#
# `--git-path` (not a literal `.git/...`) is required because in a git
# worktree, `.git` is a FILE (a gitdir pointer), not a directory — a literal
# `.git/starfish-review-ok` path can never be created there. `--git-path`
# resolves to the correct per-worktree location in both a normal checkout and
# a worktree.
#
# Recording a review (done by /starfish-code-review when run as a pre-push gate):
#   touch "$(git rev-parse --git-path starfish-review-ok)"
#
# Parsing mirrors git-branch-guard.sh: argv-style tokenization on the first
# simple command, NOT regex on the raw line, so `echo "git push"`, `git
# merge-base`, etc. never trip it.

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

# Only inspect commands whose FIRST simple-command is `git` (anchored).
NL=$'\n'
trimmed="${cmd//\\${NL}/}"
trimmed="$(printf '%s' "$trimmed" | sed -E 's/^[[:space:]]+//')"
case "$trimmed" in
  git\ *|git) ;;
  *) allow ;;
esac

# Limit inspection to the first simple command (stop at ; | &).
first="${trimmed%%[;|&]*}"

# Tokenize; positionals are tokens not starting with "-". The first positional
# after `git` is the subcommand.
read -r -a toks <<<"$first"

# De-quote tokens. `read -a` word-splits the RAW string, so `git "push"` keeps
# its quote characters in the token and would dodge the subcmd match below. The
# shell strips these before git runs, so the guard must too (mirrors
# git-branch-guard.sh). Subcommands never legitimately contain quotes.
for i in "${!toks[@]}"; do
  toks[$i]="${toks[$i]//[\"\'\`]/}"
done

# Walk tokens after `git`. Global options that TAKE an argument (-C <path>,
# -c <name>=<value>, --git-dir <path>, ...) must have that following argument
# skipped — otherwise `git -C some/dir push` reads `some/dir` as the subcommand
# and the push is never gated. The `=`-joined forms (--git-dir=path) are single
# tokens starting with "-", so they fall through to the flag case.
positionals=()
skip_next=false
for t in "${toks[@]:1}"; do
  if $skip_next; then
    skip_next=false
    continue
  fi
  case "$t" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path)
      skip_next=true ;;          # this flag consumes the next token as its value
    -*) ;;            # other flags are irrelevant to "is this a push?"
    *) positionals+=("$t") ;;
  esac
done
subcmd="${positionals[0]:-}"

# Only gate pushes; everything else is allowed.
[ "$subcmd" = "push" ] || allow

marker="$(git rev-parse --git-path starfish-review-ok 2>/dev/null || echo .git/starfish-review-ok)"
review_msg="BLOCKED: run the /starfish-code-review skill on the local diff and resolve all Critical/High findings BEFORE pushing (no GitHub needed). When the review is done, record it with: touch \"\$(git rev-parse --git-path starfish-review-ok)\"  — then re-run the push. (A new commit after the review re-arms this gate, so review the final diff.) (starfish pre-push review gate)"

# No marker → never reviewed (or marker cleared) → block.
[ -f "$marker" ] || deny "$review_msg"

# Compare marker mtime against the latest commit time. macOS (stat -f) and
# Linux (stat -c) differ; try both.
marker_mtime="$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker" 2>/dev/null || echo 0)"
last_commit="$(git log -1 --format=%ct 2>/dev/null || echo 0)"

if [ "$marker_mtime" -lt "$last_commit" ]; then
  deny "BLOCKED: the recorded code review is older than your latest commit, so the current diff is unreviewed. Re-run /starfish-code-review on the local diff, resolve Critical/High findings, then: touch \"\$(git rev-parse --git-path starfish-review-ok)\"  — and push again. (starfish pre-push review gate)"
fi

allow
