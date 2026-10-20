#!/usr/bin/env bash
# Tests for pre-push-review-guard.sh, against real throwaway git repos.
#
# Run: bash .claude/hooks/pre-push-review-guard.test.sh
# Exit 0 when all cases pass; non-zero with a per-case report otherwise.
#
# The point of using real repos: the bug this suite pins (issue #3) is that
# `git -C <dir> push` was judged by the review marker of the repo the shell was in,
# not the repo the push targets. That can't be shown with a mocked `git`.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/pre-push-review-guard.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
pass=0
fail=0

# A repo with one commit. $1 = path.
make_repo() {
  git init -q "$1"
  git -C "$1" -c user.name=t -c user.email=t@example.test commit -q --allow-empty -m init
}
marker_of() { git -C "$1" rev-parse --absolute-git-dir | sed 's#$#/starfish-review-ok#'; }
fresh()  { touch "$(marker_of "$1")"; }
# `-t [[CC]YY]MMDDhhmm` is the one form GNU and BSD (macOS) touch both accept (#277).
stale()  { touch -t 200001010000 "$(marker_of "$1")"; }
none()   { rm -f "$(marker_of "$1")"; }

# run_case <allow|deny> <cwd> <command> <description> [tool cwd]
# <cwd> is where the hook process runs. [tool cwd], when given, is the `cwd` field of the
# tool-call JSON: the directory the Bash tool runs the command in, which need not be the hook's.
run_case() {
  local expected="$1" cwd="$2" command="$3" what="$4" tool_cwd="${5:-}" out decision
  out="$(jq -n --arg c "$command" --arg d "$tool_cwd" \
    '{tool_input: {command: $c}} + (if $d == "" then {} else {cwd: $d} end)' \
    | (cd "$cwd" && bash "$HOOK"))"
  if [ -z "$out" ]; then
    decision="allow"
  else
    decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "allow"')"
  fi
  if [ "$decision" = "$expected" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: expected=$expected got=$decision | $what | cwd=$cwd | cmd: $command"
  fi
}

HERE="$ROOT/here"     # where the shell is
THERE="$ROOT/there"   # the repo a -C push targets
make_repo "$HERE"
make_repo "$THERE"
mkdir -p "$HERE/sub" "$ROOT/group"
make_repo "$ROOT/group/inner"

# ── Without -C: the repo the shell is in ────────────────────────────────────
fresh "$HERE"
run_case allow "$HERE" "git push origin x" "fresh review, no -C"
stale "$HERE"
run_case deny  "$HERE" "git push origin x" "stale review (older than the latest commit)"
none "$HERE"
run_case deny  "$HERE" "git push origin x" "no review recorded"
fresh "$HERE"
run_case allow "$HERE/sub" "git push origin x" "fresh review, shell in a subdirectory of the repo"
run_case allow "$HERE" "git status" "not a push: never gated"
run_case allow "$HERE" 'echo "git push"' "a push inside a string is not a push"

# ── With -C: the repo the push TARGETS decides, not the shell's ─────────────
fresh "$THERE"; none "$HERE"
run_case allow "$HERE" "git -C $THERE push origin x" "target reviewed, shell's repo not"
fresh "$HERE"; none "$THERE"
run_case deny  "$HERE" "git -C $THERE push origin x" "target NOT reviewed, shell's repo reviewed (the bug)"
fresh "$HERE"; stale "$THERE"
run_case deny  "$HERE" "git -C $THERE push origin x" "target's review is stale, shell's is fresh"
none "$HERE"; fresh "$THERE"
run_case allow "$HERE" "git -C $THERE push -u origin x" "flags after push, target reviewed"
run_case allow "$HERE" "git -c user.name=a -C $THERE push origin x" "-c before -C"
run_case allow "$HERE" "git -C $THERE -c user.name=a push origin x" "-c after -C"
run_case allow "$HERE" "git -C $THERE status" "-C with a non-push: never gated"

# Relative -C, and chained -C (each is relative to the one before it).
fresh "$ROOT/group/inner"; none "$HERE"
run_case allow "$ROOT" "git -C group/inner push origin x" "relative -C, target reviewed"
run_case allow "$ROOT" "git -C group -C inner push origin x" "chained -C resolve step by step"
none "$ROOT/group/inner"; fresh "$HERE"
run_case deny  "$ROOT" "git -C group -C inner push origin x" "chained -C, target not reviewed"

# A -C that names nothing: the push can't be judged, so it is blocked.
fresh "$HERE"
run_case deny  "$HERE" "git -C $ROOT/does-not-exist push origin x" "-C to a missing directory"
run_case deny  "$ROOT" "git push origin x" "not inside any repo"

# ── Compound and prefixed commands (issue #45): a push ANYWHERE on the line is gated ──
none "$HERE"
run_case deny  "$HERE" "cd /tmp && git push origin x" "cd then push"
run_case deny  "$HERE" "FOO=1 git push origin x" "env assignment before push"
run_case deny  "$HERE" "(git push origin x)" "subshell"
run_case deny  "$HERE" "git status && git push origin x" "push after another git command"
run_case deny  "$HERE" "if true; then git push origin x; fi" "push inside an if"
run_case deny  "$HERE" "command git push origin x" "command wrapper"
run_case deny  "$HERE" $'git commit -q -F - <<\'EOF\'\nmsg\nEOF\ngit push origin x' "push after a heredoc commit"
run_case deny  "$HERE" "touch $(marker_of "$HERE") && git push origin x" "touch + push chained: the hook cannot know the touch will happen"
run_case allow "$HERE" "git status && git log" "no push on the line"
run_case allow "$HERE" 'echo "a; git push origin x"' "a push inside a quoted string"
run_case allow "$HERE" "# git push origin x" "a comment"
run_case allow "$HERE" $'cat <<EOF\ngit push origin x\nEOF' "a push inside a heredoc body"
run_case allow "$HERE" "git status | grep push" "the word push is not a push"

# The push spelled differently (issue #150): still a push, still gated.
run_case deny  "$HERE" '"git" push' "quoted command word"
run_case deny  "$HERE" "'git' push origin x" "single-quoted command word"
run_case deny  "$HERE" '\git push' "backslashed command word"
run_case deny  "$HERE" '/usr/bin/git push' "command word by path"
run_case deny  "$HERE" 'command -p git push' "command -p wrapper"
run_case deny  "$HERE" 'git p\ush' "backslash inside the subcommand"
run_case deny  "$HERE" 'git "push" origin x' "quoted subcommand"
run_case deny  "$HERE" 'cd x && /usr/bin/git push origin x' "by path, after cd"
run_case allow "$HERE" 'echo "git push origin x"' "a quoted echo of a push"
run_case allow "$HERE" '"git" status' "quoted command word, not a push"
run_case allow "$HERE" 'command -v git' "command -v names git, runs nothing"
run_case allow "$HERE" "ls -la" "no git on the line: the early exit"

fresh "$HERE"
run_case allow "$HERE" '"git" push' "quoted command word, reviewed"
run_case allow "$HERE" '/usr/bin/git push origin x' "by path, reviewed"
run_case allow "$HERE" "cd /tmp && git push origin x" "cd then push, reviewed"
run_case allow "$HERE" "FOO=1 git push origin x" "env assignment, reviewed"
run_case allow "$HERE" $'git commit -q -F - <<\'EOF\'\nmsg\nEOF\ngit push origin x' "push after a heredoc commit, reviewed"

# Two pushes on one line: each is judged, against its own -C repo.
fresh "$HERE"; none "$THERE"
run_case deny  "$HERE" "git push origin x && git -C $THERE push origin x" "second push targets an unreviewed repo"
fresh "$THERE"
run_case allow "$HERE" "git push origin x && git -C $THERE push origin x" "both targets reviewed"

# ── The tool's cwd, not the hook's (#438) ───────────────────────────────────
# In a worktree session the hook process ran in another checkout than the command, so a bare
# `git push` was judged by that checkout's marker: denied although the worktree's own review was
# fresh. The tool input's `cwd` names where the command runs, and -C is relative to it.
MAIN="$ROOT/main"
WT="$ROOT/wt"
make_repo "$MAIN"
git -C "$MAIN" worktree add -q -b wt-branch "$WT"
git -C "$WT" -c user.name=t -c user.email=t@example.test commit -q --allow-empty -m "worktree work"
stale "$MAIN"; fresh "$WT"
run_case allow "$MAIN" "git push origin wt-branch" "worktree reviewed, hook run in the main checkout (stale there)" "$WT"
run_case allow "$ROOT" "git push origin wt-branch" "worktree reviewed, hook run outside any repo" "$WT"
fresh "$MAIN"; stale "$WT"
run_case deny  "$MAIN" "git push origin wt-branch" "worktree NOT reviewed, main checkout reviewed" "$WT"
none "$WT"
run_case deny  "$MAIN" "git push origin wt-branch" "worktree has no review, main checkout reviewed" "$WT"
fresh "$THERE"; none "$HERE"
run_case allow "$HERE" "git -C there push origin x" "-C is relative to the tool's cwd" "$ROOT"
none "$THERE"; fresh "$HERE"
run_case deny  "$HERE" "git -C there push origin x" "-C relative to the tool's cwd, target not reviewed" "$ROOT"
fresh "$HERE"
run_case deny  "$HERE" "git push origin x" "the tool's cwd names a missing directory: cannot be judged" "$ROOT/does-not-exist"

echo ""
echo "pre-push-review-guard tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
