#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Print the failing test files (and their failing test names) out of a unit-run
# log, so a red alert says which tests are red without anyone opening the log.
#
# Reads a plain `bun run test` capture or a `gh run view --log-failed` capture
# (whose lines carry a "<job>\t<step>\t<timestamp> " prefix).
#
# Usage: failing-tests.sh <log-file> [max-lines]
set -uo pipefail

log="${1:?usage: failing-tests.sh <log-file> [max-lines]}"
max="${2:-60}"

if [ ! -f "${log}" ]; then
  echo "(no log at ${log})"
  exit 0
fi

# The isolated runner prints one line per file — "  path/to/x.test.ts ... FAIL
# (12 pass, 1 fail)" — so the file name sits on the line *before* its verdict and
# has to be carried across. `(fail)` lines are the named tests under it.
#
# The gh prefix is stripped in awk rather than sed: `\t` is a literal "t" in a
# BSD sed ERE, so the prefix survived and every gh-prefixed line looked like a
# test name.
awk -v max="${max}" '
  {
    line = $0
    if (line ~ /^[^\t]*\t[^\t]*\t[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z /) {
      sub(/^[^\t]*\t[^\t]*\t[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z /, "", line)
    }
    if (line ~ /\.test\.tsx?[[:space:]]*\.\.\./) {
      file = line
      sub(/^[[:space:]]+/, "", file)
      sub(/[[:space:]]*\.\.\..*/, "", file)
      next
    }
    if (line ~ /^FAIL \(/) {
      if (file != "") {
        printf "FAIL %s\n", file
        n++
        if (n >= max) exit
      }
      file = ""
      next
    }
    if (line ~ /\(fail\)|✗/) {
      sub(/^[[:space:]]+/, "", line)
      printf "  %s\n", line
      n++
      if (n >= max) exit
      next
    }
  }
' "${log}"
