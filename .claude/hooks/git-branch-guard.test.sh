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

# ── Bypass spellings (issue #3): the same rules, written differently ─────────
# The five reported ones.
run_case deny  feature/x "git push --force origin HEAD:refs/heads/main"        # refs/heads/ prefix on the destination
run_case deny  feature/x "git push -uf origin main"                            # combined short flags: -u -f
run_case deny  feature/x "git -C . push -f origin main"                        # -C <dir> hid the subcommand
run_case deny  feature/x 'git commit -nm "wip"'                                # combined -n -m
run_case deny  feature/x "git -c core.hooksPath=/dev/null commit"              # hooks directory swapped for this command

# Neighbours of those, from the same root causes.
run_case deny  feature/x "git push -fu origin refs/heads/develop"              # flag order, develop
run_case deny  feature/x "git push --force origin +HEAD:refs/heads/main"       # + and refs/heads/ together
run_case deny  feature/x "git push -f origin 'HEAD:refs/heads/main'"           # quoted refspec
run_case deny  feature/x "git push --force origin +refs/heads/*:refs/heads/*"  # a glob refspec covers main
run_case deny  feature/x "git commit -anm 'x'"                                 # -a -n -m
run_case deny  feature/x "git -c user.name=a commit --no-verify -m x"          # -c <k=v> hid the subcommand
run_case deny  feature/x "git -C /tmp/other commit --no-verify -m x"           # -C hid --no-verify
run_case deny  feature/x "git -C . -c core.hooksPath=/dev/null commit"         # both globals
run_case deny  feature/x "git -c core.hooksPath=/dev/null push origin feature/x"  # on push too
run_case deny  feature/x "git -c CORE.HOOKSPATH=/dev/null commit -m x"         # config keys are case-insensitive
run_case deny  feature/x "git --config-env=core.hooksPath=EVIL commit -m x"    # --config-env form
run_case deny  feature/x "git checkout -qb hotfix/1.0.3 develop"               # combined -q -b: hotfix base rule
run_case deny  feature/x "git switch -qc hotfix/1.0.3 develop"                 # combined -q -c

# Persistent version of the hooks bypass.
run_case deny  feature/x "git config core.hooksPath /dev/null"
run_case deny  feature/x "git config --local core.hooksPath /tmp/x"
run_case allow feature/x "git config core.hooksPath .githooks"                 # what `pnpm install` sets
run_case allow feature/x "git config core.hooksPath"                           # reading it
run_case allow feature/x "git config --get core.hooksPath"
run_case allow feature/x "git config user.name x"

# -C must look at the TARGET repo's branch, and a harmless command stays harmless.
run_case allow feature/x "git -C . push origin feature/x"
run_case allow feature/x "git -C . commit -m x"
run_case allow feature/x "git -c user.name=a commit -m x"
run_case allow feature/x "git --no-pager log -1"
run_case allow feature/x "git push -u origin feature/x"
run_case allow feature/x "git push -uf origin feature/x"                       # force to own branch
run_case allow feature/x "git push -f origin HEAD:refs/heads/feature/x"        # own branch, full ref
run_case allow feature/x "git commit -am 'fix: tidy'"                          # -a -m: no -n hiding in there
run_case allow feature/x "git commit -vm 'x'"
run_case allow main      "git -C . push origin main"                           # plain push to main is fine
run_case deny  main      "git -C . push -f"                                    # current branch main, via -C

# Not a push or commit: never blocked, however it spells its flags.
run_case allow feature/x "git -C . status -sb"
run_case allow feature/x "git checkout -b feature/new origin/main"
run_case allow feature/x "git branch -f feature/x origin/main"                 # -f on branch is not a push

# ── Compound and prefixed commands (issue #45): every git command on the line is inspected ──
run_case deny  feature/x "cd /repo && git push --force origin main"
run_case deny  feature/x "echo hi; git push -f origin main"
run_case deny  feature/x "FOO=1 git push --force origin main"
run_case deny  feature/x "A=1 B=2 git push -f origin main"
run_case deny  feature/x "(git push -f origin main)"
run_case deny  feature/x "command git push -f origin main"
run_case deny  feature/x "env GIT_X=1 git push -f origin main"
run_case deny  feature/x "sudo -u deploy git push -f origin main"
run_case deny  feature/x "time git push -f origin main"
run_case deny  feature/x "if true; then git push -f origin main; fi"
run_case deny  feature/x "for b in a b; do git push -f origin main; done"
run_case deny  feature/x "git status | cat && git push -f origin main"
run_case deny  feature/x 'echo $(git push -f origin main)'
run_case deny  feature/x 'echo `git push -f origin main`'
run_case deny  feature/x "git add -A && git commit --no-verify -m x"
run_case deny  feature/x "cd x && git -C . commit -nm wip"
run_case deny  feature/x "cd x && git -c core.hooksPath=/dev/null commit"
run_case deny  feature/x "git fetch; git checkout -b hotfix/1.0.3 develop"
run_case deny  main      "cd x && git push -f"                                  # bare force push, current branch main
run_case deny  feature/x $'git commit -q -F - <<\'EOF\'\nmessage\nEOF\ngit push --force origin main'   # after a heredoc
run_case deny  feature/x $'git status\ngit push -f origin main'                  # on its own line
run_case deny  feature/x $'git commit -m x \\\n && git push -f origin main'      # after a line continuation

# Text that merely CONTAINS a git command is not a git command.
run_case allow feature/x "echo 'git push -f origin main'"
run_case allow feature/x 'echo "a; git push -f origin main"'
run_case allow feature/x 'grep -r "git push -f origin main" docs'
run_case allow feature/x 'git commit -m "docs: explain git push --force origin main"'
run_case allow feature/x '# git push -f origin main'
run_case allow feature/x $'ls # a; git push -f origin main'
run_case allow feature/x $'cat <<EOF\ngit push -f origin main\nEOF'              # heredoc body
run_case allow feature/x $'git commit -q -F - <<\'EOF\'\nuse git push --force origin main with care\ngit push -f origin main\nEOF\ngit status'
run_case allow feature/x 'cat <<<"git push -f origin main"'                       # here-string

# Ordinary compound commands stay allowed.
run_case allow feature/x "cd /repo && git push origin feature/x"
run_case allow feature/x "git add -A && git commit -m 'fix: x' && git push -u origin feature/x"
run_case allow feature/x "git status && git push --force-with-lease origin feature/x"
run_case allow feature/x "cd web && pnpm test && git status"
run_case allow feature/x "git log --oneline | head -5"
run_case allow feature/x "git diff | git apply --check"
run_case allow feature/x $'git add -A && git commit -q -F - <<\'EOF\'\nfix: don\'t "split" a; b\nEOF\ngit push --force-with-lease -u origin feature/x'

echo ""
echo "git-branch-guard tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
