#!/usr/bin/env bash
# Table-driven tests for git-branch-guard.sh.
#
# Run: bash .claude/hooks/git-branch-guard.test.sh
# Exit 0 when all cases pass; non-zero with a per-case report otherwise.
#
# Each case: <expected: allow|deny> | <current-branch> | <command>
# The hook reads the tool-call JSON on stdin and honors
# GIT_BRANCH_GUARD_CURRENT_BRANCH so cases are independent of the real repo state.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/git-branch-guard.sh"
pass=0
fail=0

run_case() {
  local expected="$1" branch="$2" command="$3"
  local out decision
  out="$(jq -n --arg c "$command" '{tool_input:{command:$c}}' \
    | GIT_BRANCH_GUARD_CURRENT_BRANCH="$branch" bash "$HOOK")"
  if [ -z "$out" ]; then
    decision="allow"
  else
    decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "allow"')"
  fi
  if [ "$decision" = "$expected" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: expected=$expected got=$decision branch='$branch' cmd: $command"
  fi
}

# ── Rule 1: hotfix creation must base on prod-aligned refs ──────────────────
# expected | current branch | command
run_case deny  develop "git checkout -b hotfix/1.0.3"                         # no base
run_case deny  develop "git checkout -b hotfix/1.0.3 develop"                 # wrong base
run_case allow develop "git checkout -b hotfix/1.0.3 origin/main"             # ok
run_case allow develop "git checkout -b hotfix/1.0.3-api hotfix/1.0.3"     # release-train parent
run_case deny  develop "git switch -c hotfix/1.0.3 develop"                   # wrong base via switch
run_case allow develop "git switch -c hotfix/1.0.3 main"                      # ok via switch
run_case deny  develop "git branch hotfix/1.0.3 develop"                      # wrong base via branch
run_case allow develop "git branch hotfix/1.0.3 origin/main"                  # ok via branch

# Flag-order robustness (false negatives)
run_case deny  develop "git checkout -q -b hotfix/1.0.3 develop"              # flag before -b
run_case deny  develop "git checkout -f --quiet -b hotfix/1.0.3 develop"      # multiple flags before -b
run_case deny  develop "git switch -q -c hotfix/1.0.3 develop"                # switch variant
run_case deny  develop "git checkout -B hotfix/1.0.3 develop"                 # force-create

# Flags after the branch name must not be read as the base (false positive)
run_case allow develop "git checkout -b hotfix/1.0.3 -t origin/main"          # -t value is the base

# Non-creation branch operations must not trigger Rule 1
run_case allow develop "git branch -d hotfix/1.0.3"                           # delete, not create
run_case allow develop "git branch -D hotfix/1.0.3"                           # force delete
run_case allow develop "git branch --list 'hotfix/*'"                         # list
run_case allow develop "git checkout hotfix/1.0.3"                            # plain checkout (no -b)

# Non-hotfix creation is unrestricted
run_case allow develop "git checkout -b feature/foo develop"
run_case allow develop "git checkout -b claude/some-branch"

# ── Rule 2: no direct merge while ON a hotfix/* branch ──────────────────────
run_case deny  hotfix/1.0.3 "git merge develop"
run_case deny  hotfix/1.0.3 "git merge --no-ff main"
run_case deny  hotfix/1.0.3 "git merge"                                       # bare merge (e.g. --continue intent)
run_case allow develop      "git merge feature/foo"                           # not on hotfix
run_case allow hotfix/1.0.3 "git merge-base origin/main HEAD"                 # read-only, must not match
run_case allow hotfix/1.0.3 "git merge-tree A B"                              # other merge-* subcommands
run_case allow hotfix/1.0.3 "git log --merges"                                # 'merge' only as a flag

# Force-push via +refspec must be caught the same as --force
run_case deny  feature/x "git push origin +develop"
run_case deny  feature/x "git push origin +main"
run_case deny  develop   "git push origin +HEAD:develop"
run_case allow feature/x "git push origin +feature/x"

# Quoted refspecs/flags must not dodge the guard. The shell
# strips these quotes before git runs, so the guard de-quotes tokens too.
run_case deny  feature/x 'git push origin "+develop"'                          # double-quoted +refspec
run_case deny  feature/x "git push origin '+main'"                             # single-quoted +refspec
run_case deny  develop   'git push origin "+HEAD:develop"'                     # quoted src:dst force refspec
run_case deny  feature/x 'git push "--force" origin main'                      # quoted --force flag
run_case deny  feature/x "git push '-f' origin develop"                        # quoted -f flag
run_case deny  feature/x 'git push --force origin "develop"'                   # quoted protected destination
run_case allow feature/x 'git push origin "+feature/x"'                        # quoted own-branch force is fine

# ── Non-git and prefix-safety cases ─────────────────────────────────────────
run_case allow hotfix/1.0.3 "echo 'git merge is fun'"                         # not a git command
run_case allow hotfix/1.0.3 "grep -r hotfix/ docs/"                           # mentions hotfix only
run_case allow develop      "gitk --all"                                      # git-prefixed binary, not git

# Compound commands: only the first simple command is inspected (documented scope)
run_case deny  develop "git checkout -b hotfix/1.0.3 develop && pnpm install"

# ── Rule 3: --no-verify bypasses the .githooks safeguards ───────────────────
run_case deny  feature/x "git commit --no-verify -m 'x'"
run_case deny  feature/x "git commit -n -m 'x'"                                # -n == --no-verify for commit
run_case deny  feature/x "git push --no-verify"
run_case deny  feature/x "git push origin feature/x --no-verify"
run_case allow feature/x "git commit -m 'x'"                                   # normal commit
run_case allow feature/x "git push -n"                                         # -n == --dry-run for push (ok)
run_case allow feature/x "git push origin feature/x"                           # normal push
run_case deny  feature/x $'git commit \\\n  --no-verify -m x'                   # --no-verify hidden on continuation line
run_case deny  feature/x $'git push origin feature/x \\\n  --no-verify'         # continuation bypass on push

# ── Rule 4: no force-push to shared protected branches ──────────────────────
run_case deny  develop   "git push --force"                                    # current branch develop
run_case deny  main      "git push -f"                                         # current branch main
run_case deny  feature/x "git push --force origin main"                        # explicit protected dest
run_case deny  feature/x "git push -f origin HEAD:develop"                     # refspec dest develop
run_case deny  develop   "git push --force-with-lease"                         # lease still rewrites shared history
run_case allow feature/x "git push --force"                                    # force to own branch (upstream feature/x)
run_case allow feature/x "git push -f origin feature/x"                        # force to own branch (explicit)
run_case allow develop   "git push origin develop"                             # non-force push to develop is fine
run_case deny  main      "git push origin HEAD --force"                        # HEAD resolves to current (main)
run_case allow feature/x "git push origin HEAD --force"                        # HEAD resolves to feature/x (ok)
run_case deny  feature/x "git push --force --all"                              # --all force overwrites every ref
run_case deny  feature/x "git push --mirror --force origin"                    # --mirror force overwrites refs

echo ""
echo "git-branch-guard tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
