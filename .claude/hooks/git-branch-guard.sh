#!/usr/bin/env bash
# PreToolUse(Bash) guard for recurring git mistakes (the table-driven .test.sh
# pins every rule).
#
#   1. hotfix/* branches MUST be created from origin/main (not develop / anything else).
#   2. No direct `git merge` while ON a hotfix/* branch (hotfixes integrate via PR, not merge).
#   3. No `--no-verify` on commit/push (it bypasses the .githooks safeguards).
#   4. No force-push to the shared protected branches (develop / main).
#
# Emits a PreToolUse deny (permissionDecision) when it catches either. Otherwise allows.
# Reads the tool-call JSON on stdin; only inspects git commands.
#
# Parsing: argv-style tokenization, NOT regex on the raw command line.
# The previous regex parser had false positives (`git merge-base` matched
# \bmerge\b; a flag after the branch name was read as the base) and false
# negatives (`git checkout -q -b ...` shifted the positional parse past the
# guard). We now split the first simple command into tokens, classify
# flag vs positional tokens, and inspect positions among the positionals.
#
# Testable: set GIT_BRANCH_GUARD_CURRENT_BRANCH to override the current-branch
# lookup (used by git-branch-guard.test.sh).

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

# Strip backslash-newline line continuations first. Without this, a command
# split across lines (e.g. `git commit \<newline>  --no-verify`) would let the
# single-line `read` below drop the continuation, hiding flags like --no-verify
# from the guard and bypassing it.
cmd="${cmd//\\$'\n'/}"

# Only inspect commands whose FIRST simple-command is `git` (anchored), so the
# rules never fire on `echo "... hotfix/ ..."`, `grep hotfix`, comments, etc.
trimmed="$(printf '%s' "$cmd" | sed -E 's/^[[:space:]]+//')"
case "$trimmed" in
  git\ *|git) ;;
  *) allow ;;
esac

# Limit inspection to the first simple command (stop at ; | & — same scope as
# the old parser; later commands in a compound line are out of scope).
first="${trimmed%%[;|&]*}"

# Tokenize and classify. Positionals are tokens not starting with "-";
# create_flag records checkout/switch branch-creation flags (-b/-B/-c/-C);
# has_other_flags tracks any flag so `git branch -d x` isn't read as creation.
read -r -a toks <<<"$first"

# De-quote tokens. `read -a` word-splits the RAW command string, so a quoted
# refspec or flag — e.g. `git push origin "+develop"`, `git push origin '+main'`,
# `git push '--force' ...` — keeps its surrounding quote characters in the
# token. Those quotes would dodge the `+*` / `--force` / protected-destination
# matching below, letting a force-push to develop/main slip past. The shell strips these quotes before git ever runs, so the guard
# must too. Branch names, flags, and refspecs never legitimately contain quote
# characters, so removing them from every token is safe and closes the bypass
# for both the force detection and the destination check.
for i in "${!toks[@]}"; do
  toks[$i]="${toks[$i]//[\"\'\`]/}"
done

positionals=()
create_flag=0
has_other_flags=0
no_verify=0   # --no-verify seen (commit/push bypass)
dash_n=0      # -n seen (means --no-verify for commit, --dry-run for push)
force=0       # --force / -f / --force-with-lease seen
all_or_mirror=0  # --all / --mirror seen (push targets many refs at once)
for t in "${toks[@]:1}"; do
  case "$t" in
    -b|-B|-c|-C) create_flag=1 ;;
    --no-verify) no_verify=1; has_other_flags=1 ;;
    -n) dash_n=1; has_other_flags=1 ;;
    -f|--force|--force-with-lease|--force-with-lease=*) force=1; has_other_flags=1 ;;
    --all|--mirror) all_or_mirror=1; has_other_flags=1 ;;
    -*) has_other_flags=1 ;;
    +*) force=1; positionals+=("$t") ;;   # +refspec (e.g. +develop) is a force-push
    *) positionals+=("$t") ;;
  esac
done

subcmd="${positionals[0]:-}"
arg1="${positionals[1]:-}"
arg2="${positionals[2]:-}"

# --- Rule 1: creating a hotfix/* branch must base on a prod-aligned ref ---
# Creation shapes:
#   git checkout -b hotfix/x [base]   git switch -c hotfix/x [base]
#   (any flag order — tokenizer handles `git checkout -q -b hotfix/x develop`)
#   git branch hotfix/x [base]        (bare: flags like -d/-D/-m mean NOT creation)
creating=0
case "$subcmd" in
  checkout|switch) [ "$create_flag" = 1 ] && creating=1 ;;
  branch) [ "$create_flag" = 0 ] && [ "$has_other_flags" = 0 ] && [ -n "$arg1" ] && creating=1 ;;
esac

if [ "$creating" = 1 ] && [[ "$arg1" == hotfix/* ]]; then
  base="$arg2"
  if [ -z "$base" ]; then
    deny "BLOCKED: a hotfix/* branch must be created from an explicit prod-aligned base (origin/main, or a parent hotfix/* branch). Re-run as: git checkout -b hotfix/... origin/main  (or the parent hotfix branch). (recurring-mistake guard)"
  fi
  case "$base" in
    origin/main|main|hotfix/*|origin/hotfix/*) ;;  # ok: prod or a hotfix parent
    *) deny "BLOCKED: hotfix/* must branch from origin/main or a parent hotfix/* branch, but you gave base '$base'. A hotfix builds only on what's live (prod) or its release-train parent — not develop/feature. (recurring-mistake guard)" ;;
  esac
fi

# --- Rule 2: no direct merge while ON a hotfix/* branch ---
# Exact subcommand match: `merge` yes; `merge-base`, `merge-tree`, etc. no.
if [ "$subcmd" = "merge" ]; then
  cur="${GIT_BRANCH_GUARD_CURRENT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"
  case "$cur" in
    hotfix/*) deny "BLOCKED: no direct 'git merge' from a hotfix branch ($cur). Hotfixes integrate via PR (base = the hotfix branch), not a local merge. (recurring-mistake guard)" ;;
  esac
fi

# --- Rule 3: --no-verify bypasses the .githooks safeguards ---
# For commit, `-n` is also --no-verify; for push, `-n` is --dry-run (harmless).
[ "$dash_n" = 1 ] && [ "$subcmd" = "commit" ] && no_verify=1
if { [ "$subcmd" = "commit" ] || [ "$subcmd" = "push" ]; } && [ "$no_verify" = 1 ]; then
  deny "BLOCKED: '--no-verify' skips the .githooks safeguards (secret scan, conventional-commit format, lint + typecheck). Run the command without it. If a hook is genuinely wrong, fix or raise the hook — don't bypass it. (safeguard)"
fi

# --- Rule 4: no force-push to the shared protected branches (develop / main) ---
# Force-push to your own feature/* or claude/* branch is fine; rewriting shared
# history on develop/main is what we block. positionals[0] == "push".
if [ "$subcmd" = "push" ] && [ "$force" = 1 ]; then
  protected=0
  cur="${GIT_BRANCH_GUARD_CURRENT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"
  # --all / --mirror force-push every ref, which includes develop/main.
  [ "$all_or_mirror" = 1 ] && protected=1
  # Explicit refspec naming a protected destination, e.g. `main`, `HEAD:develop`.
  # A bare `HEAD` resolves to the current branch, so check that too.
  for p in "${positionals[@]:1}"; do
    dest="${p##*:}"          # take the destination side of a src:dst refspec
    dest="${dest#+}"         # strip a leading + (force-push refspec marker)
    case "$dest" in
      develop|main|origin/develop|origin/main) protected=1 ;;
      HEAD) case "$cur" in develop|main) protected=1 ;; esac ;;
    esac
  done
  # No explicit branch (just `git push` or `git push <remote>`): target is the
  # current branch via its upstream. positionals are then push[+remote] (<=2).
  if [ "$protected" = 0 ] && [ "${#positionals[@]}" -le 2 ]; then
    case "$cur" in develop|main) protected=1 ;; esac
  fi
  if [ "$protected" = 1 ]; then
    deny "BLOCKED: force-push to a shared protected branch (develop/main) rewrites history others depend on. Push a normal (non-force) update or open a PR. Force-push is only for your own feature/* or claude/* branch. (safeguard)"
  fi
fi

allow
