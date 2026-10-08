#!/usr/bin/env bash
# Tests for lib/segments.sh: how a command line is split into simple commands, and which
# of those are `git`. Run: bash .claude/hooks/lib/segments.test.sh
set -u

# shellcheck source=segments.sh
source "$(cd "$(dirname "$0")" && pwd)/segments.sh"
pass=0
fail=0
SEP='¦'

join() { local out="" x; for x in "$@"; do out+="${out:+$SEP}$x"; done; printf '%s' "$out"; }

# split <expected segments joined by ¦> <command line>
split() {
  local expected="$1" cmd="$2" got
  split_segments "$cmd"
  got="$(join ${SEGMENTS[@]+"${SEGMENTS[@]}"})"
  if [ "$got" = "$expected" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL split: want [$expected] got [$got] for: $cmd"
  fi
}

# git_is <the part from git onward, or NONE> <segment>
git_is() {
  local expected="$1" seg="$2" got
  got="$(git_invocation "$seg")" || got="NONE"
  if [ "$got" = "$expected" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL git_invocation: want [$expected] got [$got] for: $seg"
  fi
}

# ── Separators ────────────────────────────────────────────────────────────────
split 'git status'                         'git status'
split 'cd /repo¦git push -f origin main'   'cd /repo && git push -f origin main'
split 'a¦b¦c'                              'a; b || c'
split 'a¦b'                                'a | b'
split 'a¦b'                                'a & b'
split 'git push -f origin main'           '(git push -f origin main)'
split 'echo $¦git push -f origin main'      'echo $(git push -f origin main)'
split 'echo¦git push -f origin main'        'echo `git push -f origin main`'
split 'if true¦then git push -f origin main¦fi' $'if true; then git push -f origin main; fi'
split 'git push¦git status'                $'git push\ngit status'
split 'git commit -m x¦git push'           $'git commit -m x \\\n&& git push'   # a line continuation vanishes
split 'ls 2>¦1'                            'ls 2>&1'                              # a redirect splits harmlessly

# ── Quotes hide separators ───────────────────────────────────────────────────
split 'echo "a; git push -f origin main"'  'echo "a; git push -f origin main"'
split "echo 'a && git push -f'"            "echo 'a && git push -f'"
split 'git commit -m "fix: a | b; c"¦git push' 'git commit -m "fix: a | b; c" && git push'
split 'echo "say \"hi; there\""'           'echo "say \"hi; there\""'
split 'echo a\;b'                          'echo a\;b'
split "git push origin 'HEAD:refs/heads/main'" "git push origin 'HEAD:refs/heads/main'"
split 'echo "multi
line; text"'                               $'echo "multi\nline; text"'

# An unclosed quote swallows the rest, as it would in the shell (and cannot hang the hook).
split 'echo "never closed; git push -f'    'echo "never closed; git push -f'
split "echo 'never closed; git push -f"    "echo 'never closed; git push -f"
split 'a¦echo "x"¦b'                       'a; echo "x"; b'
split 'echo "a\"b" c¦d'                   'echo "a\"b" c; d'                     # an escaped quote does not close the string

# ── Comments ─────────────────────────────────────────────────────────────────
split 'ls'                                 $'ls # a; git push -f origin main'
split 'ls¦git status'                      $'ls\n# git push -f\ngit status'
split 'echo a#b¦c'                         'echo a#b; c'                         # # inside a word is not a comment

# ── Heredocs: bodies are text ────────────────────────────────────────────────
split "git commit -F - <<'EOF'¦git push" $'git commit -F - <<\'EOF\'\nit\'s "quoted"; git push -f origin main\nEOF\ngit push'
split 'cat <<EOF¦ls'                       $'cat <<EOF\ngit push -f origin main\nEOF\nls'
split 'cat <<-EOF¦ls'                      $'cat <<-EOF\n\tgit push -f origin main\n\tEOF\nls'
split "cat <<'A' <<'B'¦ls"                 $'cat <<\'A\' <<\'B\'\none\nA\ntwo\nB\nls'
split 'cat <<<"git push -f origin main"'   'cat <<<"git push -f origin main"'    # a here-STRING is not a heredoc
split 'cat <<EOF'                          $'cat <<EOF\nnever closed; git push -f'  # an unclosed heredoc swallows the rest

# The shape of a real chained commit (message with apostrophes, then touch + push).
split "git add -A¦git commit -q -F - <<'EOF'¦touch m¦git push --force-with-lease -u origin claude/x" \
  $'git add -A && git commit -q -F - <<\'EOF\'\nfix: don\'t "split" a; b\nEOF\ntouch m && git push --force-with-lease -u origin claude/x'

# ── git_invocation: assignments and wrappers ─────────────────────────────────
git_is 'git push -f'                'git push -f'
git_is 'git push -f'                '   git push -f'
git_is 'git push -f'                'FOO=1 git push -f'
git_is 'git push -f'                'A=1 B=two git push -f'
git_is 'git push -f'                'command git push -f'
git_is 'git push -f'                'exec git push -f'
git_is 'git push -f'                'time git push -f'
git_is 'git push -f'                'env GIT_X=1 git push -f'
git_is 'git push -f'                'env -i GIT_X=1 git push -f'
git_is 'git push -f'                'env -u HOME git push -f'
git_is 'git push -f'                'sudo git push -f'
git_is 'git push -f'                'sudo -u deploy git push -f'
git_is 'git push -f'                'nice -n 5 git push -f'
git_is 'git push -f'                'then git push -f'
git_is 'git push -f'                'do git push -f'
git_is 'git push -f'                '{ git push -f'
git_is 'git push -f'                '! git push -f'
git_is 'git'                        'git'

# The command word as the shell reads it (issue #150): quotes, backslashes and a path all
# still mean git, and the printed part starts with a plain `git`.
git_is 'git push -f origin main'    '"git" push -f origin main'
git_is 'git push -f origin main'    "'git' push -f origin main"
git_is 'git push -f origin main'    '\git push -f origin main'
git_is 'git push -f origin main'    'g\it push -f origin main'
git_is 'git push -f origin main'    '/usr/bin/git push -f origin main'
git_is 'git push -f origin main'    '"/usr/bin/git" push -f origin main'
git_is 'git push -f origin main'    './git push -f origin main'
git_is 'git push -f origin main'    'command -p git push -f origin main'
git_is 'git push -f origin main'    'FOO=/a/b /usr/bin/git push -f origin main'   # a / in an assignment's value
git_is 'git push -f origin main'    '/usr/bin/env git push -f origin main'
git_is 'git push -f origin main'    '"command" -p "git" push -f origin main'
git_is 'git p\ush'                  'git p\ush'                                  # the hooks de-quote the rest
git_is NONE                         'command -v git'                             # names git, does not run it
git_is NONE                         'command -V git push'
git_is NONE                         '/usr/bin/gitk push'
git_is NONE                         '"github" push -f'
git_is NONE                         'echo "git" push'
git_is NONE                         'echo git push -f'
git_is NONE                         'gitk push'
git_is NONE                         'github push -f'
git_is NONE                         'git-lfs push'
git_is NONE                         '# git push'
git_is NONE                         ''
git_is NONE                         'FOO=1'
git_is NONE                         '-u deploy git push'                          # an option with no wrapper before it
git_is NONE                         'grep -r git push'

# ── bare_word ────────────────────────────────────────────────────────────────
bare_is() {
  bare_word "$2"
  if [ "$BARE_WORD" = "$1" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL bare_word: want [$1] got [$BARE_WORD] for: $2"
  fi
}
bare_is 'push'        'p\ush'
bare_is 'push'        '"push"'
bare_is 'push'        "'push'"
bare_is ':main'       '\:main'
bare_is 'origin'      'origin'

# ── may_run_git: the hooks' early exit ───────────────────────────────────────
may_is() {
  local got=no
  may_run_git "$2" && got=yes
  if [ "$got" = "$1" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL may_run_git: want [$1] got [$got] for: $2"
  fi
}
may_is yes 'git push'
may_is yes 'cd x && /usr/bin/git push'
may_is yes 'g"i"t push'
may_is yes $'g\\\nit push -f origin main'                                 # a line continuation inside the word
may_is no  'ls -la && pnpm test'
may_is no  ''

echo ""
echo "segments tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
