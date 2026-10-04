# Shared by git-branch-guard.sh and pre-push-review-guard.sh (sourced, not run).
#
# Splits a shell command line into its SIMPLE commands, so a hook can inspect every
# `git ...` in `cd x && git push -f origin main`, `FOO=1 git push`, `(git push -f)`,
# `if ok; then git push -f origin main; fi`, and so on, not just a command that happens
# to start the line.
#
#   split_segments "<command line>"    # fills the global array SEGMENTS
#   git_invocation "<segment>"         # prints the segment from its `git` onward, or returns 1
#
# What it understands, deliberately little:
#   - separators outside quotes: ; & | ( ) ` and newline (so &&, ||, $( ) and { } too)
#   - 'single' and "double" quotes (with backslash escapes), so a ; or && inside a quoted
#     commit message does not split anything
#   - # comments, so `# a; git push -f` is not a command
#   - heredoc bodies (<<EOF, <<-EOF, <<'EOF'), which are text, not commands
#   - leading VAR=value assignments and the wrappers command/builtin/exec/time/nohup/env/
#     sudo/nice (and shell keywords then/do/else/if/while/until/!)
#
# What it does NOT understand, so does not claim to catch:
#   - code inside strings: `bash -c "git push -f ..."`, `eval "..."`, and `$( )` or backticks
#     INSIDE double quotes
#   - where the shell is: `cd other && git push` is judged by the hook's own directory
#   - aliases, functions, scripts that run git, or `git` reached through a variable
#
# Kept to bash 3.2 features (macOS ships it): no ${var,,}, no `local -n`, no associative arrays.

SEGMENTS=()

# Append a segment, trimmed, unless it is empty.
_push_segment() {
  local t="$1"
  t="${t#"${t%%[![:space:]]*}"}"
  t="${t%"${t##*[![:space:]]}"}"
  [ -n "$t" ] && SEGMENTS+=("$t")
  return 0
}

split_segments() {
  SEGMENTS=()
  local s="$1" n=${#1} i=0 c state=none seg="" delims="" dash line rest chunk delim word
  local nl=$'\n' rs=$'\x1e'

  while [ "$i" -lt "$n" ]; do
    c="${s:i:1}"

    case "$state" in
      sq)
        # Jump to the closing quote in one step instead of walking a long message char by char.
        rest="${s:i}"; chunk="${rest%%\'*}"
        if [ "${#chunk}" -ge "${#rest}" ]; then seg+="$rest"; i=$n; continue; fi   # never closed
        seg+="${s:i:${#chunk}+1}"; i=$((i + ${#chunk} + 1)); state=none; continue ;;
      dq)
        rest="${s:i}"; chunk="${rest%%[\"\\]*}"           # up to the next quote or backslash
        if [ "${#chunk}" -ge "${#rest}" ]; then seg+="$rest"; i=$n; continue; fi   # never closed
        seg+="$chunk"; i=$((i + ${#chunk})); c="${s:i:1}"
        if [ "$c" = "\\" ]; then seg+="${s:i:2}"; i=$((i + 2)); continue; fi
        seg+="$c"; i=$((i + 1)); state=none; continue ;;
    esac

    case "$c" in
      "'") state=sq; seg+="$c" ;;
      '"') state=dq; seg+="$c" ;;
      "\\")
        # A backslash-newline is a line continuation and vanishes; any other escape stays.
        if [ "${s:i+1:1}" = "$nl" ]; then i=$((i + 2)); else seg+="${s:i:2}"; i=$((i + 2)); fi
        continue ;;
      '#')
        # A comment runs to the end of the line, but only when # starts a word.
        if [ -z "$seg" ] || [[ "$seg" == *[[:space:]] ]]; then
          while [ "$i" -lt "$n" ] && [ "${s:i:1}" != "$nl" ]; do i=$((i + 1)); done
          continue
        fi
        seg+="$c" ;;
      ';'|'&'|'|'|'('|')'|'`')
        _push_segment "$seg"; seg="" ;;
      '<')
        if [ "${s:i:2}" = "<<" ] && [ "${s:i:3}" != "<<<" ]; then
          # A heredoc: remember its delimiter; the body (after the next newline) is text.
          j=$((i + 2)); dash=0
          [ "${s:j:1}" = "-" ] && { dash=1; j=$((j + 1)); }
          while [ "${s:j:1}" = " " ] || [ "${s:j:1}" = $'\t' ]; do j=$((j + 1)); done
          word=""
          while [ "$j" -lt "$n" ]; do
            case "${s:j:1}" in
              [[:space:]]|';'|'&'|'|'|'('|')'|'<'|'>') break ;;
              "'"|'"'|"\\") ;;                      # quoting of the delimiter: not part of it
              *) word+="${s:j:1}" ;;
            esac
            j=$((j + 1))
          done
          seg+="${s:i:j-i}"
          [ -n "$word" ] && delims+="${dash}${word}${rs}"
          i=$j; continue
        fi
        seg+="$c" ;;
      "$nl")
        _push_segment "$seg"; seg=""
        # Skip the body of every heredoc opened on this line, up to its delimiter line.
        while [ -n "$delims" ]; do
          delim="${delims%%"$rs"*}"; delims="${delims#*"$rs"}"
          dash="${delim:0:1}"; delim="${delim:1}"
          while [ "$i" -lt "$n" ]; do
            rest="${s:i+1}"; line="${rest%%"$nl"*}"
            i=$((i + 1 + ${#line}))
            [ "$dash" = 1 ] && line="${line#"${line%%[!	]*}"}"
            [ "$line" = "$delim" ] && break
          done
        done ;;
      *) seg+="$c" ;;
    esac
    i=$((i + 1))
  done
  _push_segment "$seg"
  return 0
}

# Print the part of a simple command that starts at `git` (after any assignments and
# wrappers), or return 1 if the command is not a git command.
git_invocation() {
  local rest="$1" word skip=0 wrapper=""
  rest="${rest#"${rest%%[![:space:]]*}"}"
  while :; do
    word="${rest%%[[:space:]]*}"
    [ -z "$word" ] && return 1
    if [ "$skip" = 1 ]; then
      skip=0
    else
      case "$word" in
        git) printf '%s' "$rest"; return 0 ;;
        [A-Za-z_]*=*) ;;
        command|builtin|exec|time|nohup|then|do|else|elif|if|while|until|'!'|'{') ;;
        env|sudo|nice) wrapper="$word" ;;
        -*)
          # An option of env/sudo/nice, some of which take a value.
          [ -z "$wrapper" ] && return 1
          case "$wrapper:$word" in
            sudo:-u|sudo:-g|sudo:-C|sudo:-h|sudo:-p|sudo:-r|sudo:-t|sudo:-U|env:-u|env:-C|env:-S|nice:-n) skip=1 ;;
          esac ;;
        *) return 1 ;;
      esac
    fi
    rest="${rest#"$word"}"
    rest="${rest#"${rest%%[![:space:]]*}"}"
  done
}
