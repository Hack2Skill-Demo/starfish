#!/usr/bin/env bash
# PreToolUse(Bash) guard for recurring git mistakes (the table-driven .test.sh
# pins every rule).
#
#   1. hotfix/* branches MUST be created from origin/main (not develop / anything else).
#   2. No direct `git merge` while ON a hotfix/* branch (hotfixes integrate via PR, not merge).
#   3. No `--no-verify` on commit/push (it bypasses the .githooks safeguards), and no
#      `-c core.hooksPath=...` override or `git config core.hooksPath <elsewhere>`
#      (they switch the same safeguards off).
#   4. No force-push to the shared protected branches (develop / main).
#   5. No `git push --mirror`, and no deleting develop/main on the remote (`--delete main`,
#      `-d main`, or the refspec `:main`).
#
# Emits a PreToolUse deny (permissionDecision) when it catches one. Otherwise allows.
# Reads the tool-call JSON on stdin; only inspects git commands.
#
# Parsing: argv-style tokenization, NOT regex on the raw command line.
# The previous regex parser had false positives (`git merge-base` matched
# \bmerge\b; a flag after the branch name was read as the base) and false
# negatives (`git checkout -q -b ...` shifted the positional parse past the
# guard). We now split the first simple command into tokens, classify
# flag vs positional tokens, and inspect positions among the positionals.
#
# Global options come first. `git [-C <dir>] [-c <k=v>] [--git-dir <p>] ... <subcommand>`:
# the options that TAKE an argument must have it skipped, or `git -C . push -f` reads
# `.` as the subcommand and the push is never inspected at all. Short flags may also be
# combined (`-uf`, `-nm`, `-qb`), so each letter is classified, not just whole tokens.
#
# Every simple command on the line is inspected, not just the first: `cd x && git push -f`,
# `FOO=1 git push`, `(git push -f)`, `if ok; then git push -f; fi` and a push chained after a
# heredoc commit are all seen (lib/segments.sh says exactly what it does and does not follow).
# It does NOT look inside strings (`bash -c "git push -f"`, `eval`, `$( )` inside double
# quotes), follow `cd` (the current branch is the hook's own directory's), or catch aliases
# and scripts that run git. These hooks stop recurring mistakes; they are not a sandbox.
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

# shellcheck source=lib/segments.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/segments.sh"

# settings.json runs this on EVERY Bash call (no `if` filter, which would miss `"git"`,
# `\git` and `/usr/bin/git`), so leave at once when no spelling of git can be on the line.
may_run_git "$cmd" || allow

# Tokenize and classify. Positionals are tokens not starting with "-";
# create_flag records checkout/switch branch-creation flags (-b/-B/-c/-C);
# has_other_flags tracks any flag so `git branch -d x` isn't read as creation.
split_segments "$cmd"

# Apply every rule to ONE simple git command ($1: the segment from `git` onward). A rule that
# fires denies and exits; otherwise this returns and the next segment is inspected.
inspect_git() {
  local first="${1//$'\n'/ }"   # a quoted multi-line message must not hide the flags after it
  read -r -a toks <<<"$first"

  # De-quote tokens. `read -a` word-splits the RAW command string, so a quoted
  # refspec or flag — e.g. `git push origin "+develop"`, `git push origin '+main'`,
  # `git push '--force' ...` — keeps its surrounding quote characters in the
  # token. Those quotes would dodge the `+*` / `--force` / protected-destination
  # matching below, letting a force-push to develop/main slip past. The shell strips these quotes before git ever runs, so the guard
  # must too. Branch names, flags, and refspecs never legitimately contain quote
  # characters, so removing them from every token is safe and closes the bypass
  # for both the force detection and the destination check. Backslashes go too
  # (`git p\ush`, `git push origin \:main`): the shell drops them the same way (bare_word).
  for i in "${!toks[@]}"; do
    bare_word "${toks[$i]}"
    toks[$i]="$BARE_WORD"
  done

  # Global options (before the subcommand). -C and -c are remembered: -C changes which
  # repo the command runs in (so the current branch must be looked up there), and -c is
  # where `core.hooksPath` overrides hide.
  c_dirs=()        # -C <dir>, applied in order, each relative to the previous
  cfg_overrides=() # -c <name>=<value> and --config-env=<name>=<ENV>
  i=1
  n=${#toks[@]}
  while [ "$i" -lt "$n" ]; do
    t="${toks[$i]}"
    case "$t" in
      -C) c_dirs+=("${toks[$((i + 1))]:-}"); i=$((i + 2)) ;;
      -c) cfg_overrides+=("${toks[$((i + 1))]:-}"); i=$((i + 2)) ;;
      --config-env=*) cfg_overrides+=("${t#--config-env=}"); i=$((i + 1)) ;;
      --config-env) cfg_overrides+=("${toks[$((i + 1))]:-}"); i=$((i + 2)) ;;
      --git-dir|--work-tree|--namespace|--exec-path|--super-prefix) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;   # --no-pager, -p, --bare, --git-dir=<p>, ... take no separate argument
      *) break ;;
    esac
  done
  subcmd="${toks[$i]:-}"
  args=()
  [ "$i" -lt "$n" ] && args=("${toks[@]:$((i + 1))}")

  # Run git in the repo the command targets (honouring -C), for the branch lookups below.
  # (Kept to bash 3.2 features: macOS ships it. No ${var,,}, no `local` arrays.)
  c_args=()
  for d in ${c_dirs[@]+"${c_dirs[@]}"}; do c_args+=(-C "$d"); done
  repo_git() { git ${c_args[@]+"${c_args[@]}"} "$@"; }
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
  current_branch() {
    printf '%s' "${GIT_BRANCH_GUARD_CURRENT_BRANCH:-$(repo_git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"
  }

  # Classify the subcommand's own arguments. Positionals are tokens not starting with "-".
  positionals=()
  create_flag=0
  has_other_flags=0
  no_verify=0   # --no-verify seen (commit/push bypass)
  dash_n=0      # -n seen (means --no-verify for commit, --dry-run for push)
  force=0       # --force / -f / --force-with-lease seen
  all_or_mirror=0  # --all / --mirror seen (push targets many refs at once)
  mirror=0      # --mirror seen (push: overwrites AND deletes remote refs, force implied)
  delete=0      # --delete / -d seen (push: every named ref is deleted on the remote)
  past_dashdash=0
  for t in ${args[@]+"${args[@]}"}; do
    if [ "$past_dashdash" = 1 ]; then positionals+=("$t"); continue; fi
    case "$t" in
      --) past_dashdash=1 ;;
      --no-verify) no_verify=1; has_other_flags=1 ;;
      --force|--force-with-lease|--force-with-lease=*) force=1; has_other_flags=1 ;;
      --all) all_or_mirror=1; has_other_flags=1 ;;
      --mirror) all_or_mirror=1; mirror=1; has_other_flags=1 ;;
      --delete) delete=1; has_other_flags=1 ;;
      --*) has_other_flags=1 ;;
      -?*)
        # Short flags, possibly combined (-uf, -nm, -qb). Classify each letter. A letter
        # that takes a value (-m msg, -F file, -S key, -o opt) ends the run: whatever
        # follows it in this token is that value, not more flags.
        has_other_flags=1
        letters="${t#-}"
        for ((k = 0; k < ${#letters}; k++)); do
          case "${letters:k:1}" in
            b|B|c|C) create_flag=1 ;;
            d) delete=1 ;;   # only read for push (`git branch -d` is a local delete, not a rule)
            n) dash_n=1 ;;
            f) force=1 ;;
            m|F|S|o) break ;;
          esac
        done
        ;;
      +*) force=1; positionals+=("$t") ;;   # +refspec (e.g. +develop) is a force-push
      *) positionals+=("$t") ;;
    esac
  done

  arg1="${positionals[0]:-}"
  arg2="${positionals[1]:-}"

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
    cur="$(current_branch)"
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

  # `-c core.hooksPath=...` (or --config-env) points git at a different hooks directory
  # for this one command, which switches the .githooks safeguards off without --no-verify.
  # Config keys are case-insensitive, so match accordingly.
  for override in ${cfg_overrides[@]+"${cfg_overrides[@]}"}; do
    if [[ "$(lower "$override")" == core.hookspath=* ]]; then
      deny "BLOCKED: '-c core.hooksPath=...' points git at a different hooks directory, which skips the .githooks safeguards (secret scan, conventional-commit format, lint + typecheck) just like --no-verify. Run the command without it. (safeguard)"
    fi
  done

  # `git config core.hooksPath <elsewhere>` does the same persistently. Reading it, and
  # setting it to the repo's own .githooks (what `pnpm install` does), stay allowed.
  if [ "$subcmd" = "config" ]; then
    seen_key=0
    for p in ${positionals[@]+"${positionals[@]}"}; do
      if [ "$seen_key" = 1 ]; then
        [ "$p" = ".githooks" ] || deny "BLOCKED: 'git config core.hooksPath $p' points git away from .githooks, which switches off the commit/push safeguards for every later command. Leave it at .githooks (set by 'pnpm install'). (safeguard)"
        break
      fi
      [[ "$(lower "$p")" == "core.hookspath" ]] && seen_key=1
    done
  fi

  # --- Rule 4: no force-push to the shared protected branches (develop / main) ---
  # Force-push to your own feature/* or claude/* branch is fine; rewriting shared
  # history on develop/main is what we block. positionals[0] == "push".
  if [ "$subcmd" = "push" ] && [ "$force" = 1 ]; then
    protected=0
    cur="$(current_branch)"
    # --all / --mirror force-push every ref, which includes develop/main.
    [ "$all_or_mirror" = 1 ] && protected=1
    # Explicit refspec naming a protected destination, e.g. `main`, `HEAD:develop`,
    # `HEAD:refs/heads/main`. A bare `HEAD` resolves to the current branch, so check
    # that too.
    for p in ${positionals[@]+"${positionals[@]}"}; do
      dest="${p##*:}"          # take the destination side of a src:dst refspec
      dest="${dest#+}"         # strip a leading + (force-push refspec marker)
      dest="${dest#refs/heads/}"  # refs/heads/main is main
      case "$dest" in
        develop|main|origin/develop|origin/main) protected=1 ;;
        *\**) protected=1 ;;    # a glob refspec (+refs/heads/*:refs/heads/*) covers develop/main
        HEAD) case "$cur" in develop|main) protected=1 ;; esac ;;
      esac
    done
    # No explicit branch (just `git push` or `git push <remote>`): target is the
    # current branch via its upstream. positionals are then [remote] (<=1).
    if [ "$protected" = 0 ] && [ "${#positionals[@]}" -le 1 ]; then
      case "$cur" in develop|main) protected=1 ;; esac
    fi
    if [ "$protected" = 1 ]; then
      deny "BLOCKED: force-push to a shared protected branch (develop/main) rewrites history others depend on. Push a normal (non-force) update or open a PR. Force-push is only for your own feature/* or claude/* branch. (safeguard)"
    fi
  fi

  # --- Rule 5: no mirror push, and no deleting a protected branch on the remote ---
  # `--mirror` makes the remote's refs match the local ones, force-updating AND deleting,
  # whether or not -f is given, so it is blocked outright. A branch is deleted by
  # `--delete <name>` / `-d <name>` or by a refspec with an empty source (`:main`).
  if [ "$subcmd" = "push" ]; then
    if [ "$mirror" = 1 ]; then
      deny "BLOCKED: 'git push --mirror' force-updates and deletes remote refs to match this clone, which can rewrite or remove develop/main. Push the branch you mean by name. (safeguard)"
    fi
    cur="$(current_branch)"
    idx=0
    for p in ${positionals[@]+"${positionals[@]}"}; do
      idx=$((idx + 1))
      ref="${p#+}"
      if [[ "$ref" == :* ]]; then
        ref="${ref#:}"                    # `:main`: push nothing to main, i.e. delete it
      elif [ "$delete" = 0 ] || [ "$idx" = 1 ]; then
        continue                          # not a deletion, or the remote (the first positional)
      fi
      ref="${ref#refs/heads/}"
      [ "$ref" = HEAD ] && ref="$cur"
      case "$ref" in
        develop|main) deny "BLOCKED: deleting the shared protected branch '$ref' on the remote. Delete your own feature/* or claude/* branches only. (safeguard)" ;;
      esac
    done
  fi
}

for segment in ${SEGMENTS[@]+"${SEGMENTS[@]}"}; do
  invocation="$(git_invocation "$segment")" || continue
  inspect_git "$invocation"
done

allow
