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
# Parsing mirrors git-branch-guard.sh: the line is split into its simple commands
# (lib/segments.sh), and each `git` command is tokenized argv-style, NOT matched by regex on
# the raw line, so `echo "git push"`, `git merge-base`, etc. never trip it. A push anywhere on
# the line is gated, so `cd x && git push` and `FOO=1 git push` are seen, and so is a push
# chained after the `touch` that records the review: that one is blocked, because the hook
# runs BEFORE the command and cannot know the touch will happen. Record the review in its own
# step, then push.

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

# shellcheck source=lib/segments.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/segments.sh"

# settings.json runs this on EVERY Bash call (no `if` filter, which would miss `"git"`,
# `\git` and `/usr/bin/git`), so leave at once when no spelling of git can be on the line.
may_run_git "$cmd" || allow

split_segments "$cmd"

# Walk the tokens after `git`. Global options that TAKE an argument (-C <path>,
# -c <name>=<value>, --git-dir <path>, ...) must have that following argument
# skipped, otherwise `git -C some/dir push` reads `some/dir` as the subcommand
# and the push is never gated. The `=`-joined forms (--git-dir=path) are single
# tokens starting with "-", so they fall through to the flag case.
# Sets: subcmd, and c_dirs (the -C values, in order; each is relative to the one before).
parse_git() {
  local first="${1//$'\n'/ }" t skip_next=false take_c=false
  local -a toks
  read -r -a toks <<<"$first"

  # De-quote tokens. `read -a` word-splits the RAW string, so `git "push"` keeps
  # its quote characters in the token and would dodge the subcmd match below. The
  # shell strips these before git runs, so the guard must too (mirrors
  # git-branch-guard.sh). Backslashes likewise: `git p\ush` is a push (bare_word).
  # Subcommands never legitimately contain quotes or backslashes.
  local i
  for i in "${!toks[@]}"; do
    bare_word "${toks[$i]}"
    toks[$i]="$BARE_WORD"
  done

  subcmd=""
  c_dirs=()
  for t in "${toks[@]:1}"; do
    if $skip_next; then
      skip_next=false
      $take_c && c_dirs+=("$t")
      take_c=false
      continue
    fi
    case "$t" in
      -C) skip_next=true; take_c=true ;;   # consumes the next token, and it is a directory
      -c|--git-dir|--work-tree|--namespace|--exec-path)
        skip_next=true ;;          # this flag consumes the next token as its value
      -*) ;;            # other flags are irrelevant to "is this a push?"
      *) subcmd="$t"; return 0 ;;
    esac
  done
  return 0
}

# The push runs in the repo `-C` points at, so the review marker and the latest commit
# must come from THAT repo, not the directory the shell happens to be in. Otherwise
# `git -C other/repo push` is judged by the wrong repo's marker: allowed on a stale
# review, or blocked on a fresh one. Run the lookups there, and make the marker path
# absolute, since `--git-path` is relative to the repo it ran in.
in_repo() {
  (
    for d in ${c_dirs[@]+"${c_dirs[@]}"}; do cd "$d" || exit 1; done
    "$@"
  )
}
# Judge ONE push against the review marker of the repo it targets (c_dirs). A failure denies
# and exits; otherwise this returns.
gate_push() {
  local marker_rel marker marker_mtime last_commit review_msg
  marker_rel="$(in_repo git rev-parse --git-path starfish-review-ok 2>/dev/null || true)"
  case "$marker_rel" in
    "") marker="" ;;                 # not a repo, or -C names nothing: no marker, so the push is blocked
    /*) marker="$marker_rel" ;;
    *)  marker="$(in_repo pwd)/$marker_rel" ;;
  esac
  review_msg="BLOCKED: run the /starfish-code-review skill on the local diff and resolve all Critical/High findings BEFORE pushing (no GitHub needed). When the review is done, record it with: touch \"\$(git rev-parse --git-path starfish-review-ok)\"  — then re-run the push. (A new commit after the review re-arms this gate, so review the final diff.) (starfish pre-push review gate)"

  # No marker → never reviewed (or marker cleared) → block.
  [ -n "$marker" ] && [ -f "$marker" ] || deny "$review_msg"

  # Compare marker mtime against the latest commit time. macOS (stat -f) and
  # Linux (stat -c) differ; try both.
  marker_mtime="$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker" 2>/dev/null || echo 0)"
  last_commit="$(in_repo git log -1 --format=%ct 2>/dev/null || echo 0)"

  if [ "$marker_mtime" -lt "$last_commit" ]; then
    deny "BLOCKED: the recorded code review is older than your latest commit, so the current diff is unreviewed. Re-run /starfish-code-review on the local diff, resolve Critical/High findings, then: touch \"\$(git rev-parse --git-path starfish-review-ok)\"  — and push again. (starfish pre-push review gate)"
  fi
}

for segment in ${SEGMENTS[@]+"${SEGMENTS[@]}"}; do
  invocation="$(git_invocation "$segment")" || continue
  parse_git "$invocation"
  [ "$subcmd" = "push" ] && gate_push
done

allow
