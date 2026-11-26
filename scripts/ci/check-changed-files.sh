#!/usr/bin/env bash
set -euo pipefail

# Formats, lints and checks the English-only rule on the files a change adds
# or modifies. Published built-in Skill versions are immutable and never
# reformatted. The client's translation catalogs under
# apps/web/src/i18n/locales/ are formatted like any other file and are the one
# place the English-only rule does not apply.
#
# Usage: check-changed-files.sh <base> <head>   diff two commits (the gate)
#        check-changed-files.sh <base> --worktree
#          diff the working tree, plus untracked files (local make check)
#        check-changed-files.sh <base> <head> <app-linted-paths>
#          also skip ESLint under the prefixes listed one per line in the
#          file; prettier and the English-only check still cover them

if (($# != 2 && $# != 3)); then
  echo "Usage: $0 <base> (<head> [<app-linted-paths>] | --worktree)" >&2
  exit 2
fi
base=$1
app_linted=()
if (($# == 3)); then
  [[ "$2" != --worktree ]] || {
    echo "Usage: $0 <base> (<head> [<app-linted-paths>] | --worktree)" >&2
    exit 2
  }
  while IFS= read -r prefix; do
    if [[ -n "$prefix" ]]; then app_linted+=("$prefix"); fi
  done <"$3"
fi
if [[ "$2" == --worktree ]]; then
  list_changed() {
    git -c core.quotePath=false diff -z --name-only --no-renames --diff-filter=ACMRT "$base"
    git -c core.quotePath=false ls-files -z --others --exclude-standard
  }
else
  head=$2
  list_changed() {
    git -c core.quotePath=false diff -z --name-only --no-renames --diff-filter=ACMRT "$base" "$head"
  }
fi

prettier_files=()
eslint_files=()
english_only_files=()
while IFS= read -r -d '' file; do
  [[ "$file" =~ ^skills/builtin/[^/]+/[^/]+/ ]] && continue
  [[ -f "$file" ]] || continue
  case "$file" in
    *.cjs | *.css | *.html | *.js | *.json | *.jsonc | *.jsx | *.md | *.mdx | *.mjs | *.mts | *.scss | *.ts | *.tsx | *.yaml | *.yml)
      prettier_files+=("$file")
      ;;
  esac
  case "$file" in
    *.cjs | *.cts | *.js | *.jsx | *.mjs | *.mts | *.ts | *.tsx)
      app_lints=false
      for prefix in ${app_linted[@]+"${app_linted[@]}"}; do
        if [[ "$file" == "$prefix"* ]]; then
          app_lints=true
          break
        fi
      done
      if [[ "$app_lints" == false ]]; then eslint_files+=("$file"); fi
      ;;
  esac
  # Translation catalogs: the Web client's, the desktop shell's and the
  # Mobile App's.
  case "$file" in
    apps/web/src/i18n/locales/* | apps/desktop/src/i18n/locales/* | apps/mobile/src/i18n/locales/*) ;;
    *) english_only_files+=("$file") ;;
  esac
done < <(list_changed)
if ((${#prettier_files[@]} > 0)); then
  pnpm exec prettier --check "${prettier_files[@]}"
fi
if ((${#eslint_files[@]} > 0)); then
  pnpm exec eslint "${eslint_files[@]}"
fi

# The repository is English-only. Only CJK ideographs are rejected, so tests
# may still use kana, Hangul, and full-width punctuation as unspaced scripts.
# git grep exits 1 when nothing matches; any other non-zero status is an error
# (for example a git without PCRE), which must fail the check rather than pass
# it. --untracked lets the local run see files not yet added.
if ((${#english_only_files[@]} > 0)); then
  cjk_status=0
  LC_ALL=C git grep --untracked -nIP '(*UTF)[\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}]' -- "${english_only_files[@]}" || cjk_status=$?
  if ((cjk_status == 0)); then
    echo "Changed files contain Chinese characters; the repository is English-only (see AGENTS.md)." >&2
    exit 1
  elif ((cjk_status != 1)); then
    echo "The English-only check could not run (git grep exited $cjk_status)." >&2
    exit 1
  fi
fi
