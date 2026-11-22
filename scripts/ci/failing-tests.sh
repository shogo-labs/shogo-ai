#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Print the failing test files (and their failing test names) out of a unit-run
# log, so a red alert says which tests are red without opening the log.
#
# Reads a plain `bun run test` capture, a `gh run view --log-failed` capture
# (whose lines carry a "<job>\t<step>\t<timestamp> " prefix), or a
# `gh api .../actions/jobs/<id>/logs` capture (bare "<timestamp> " prefix).
# The per-job form is what main-health.yml uses: a whole-run log is refused
# while the run is still in progress, and the report step is part of that run.
#
# Usage: failing-tests.sh <log-file> [max-lines]
set -uo pipefail

log="${1:?usage: failing-tests.sh <log-file> [max-lines]}"
max="${2:-60}"

if [ ! -f "${log}" ]; then
  echo "(no log at ${log})"
  exit 0
fi

# Two sources, in order of trust:
#
# 1. The isolated runner's own "Failed files (N):" block, printed at the end of
#    the run as "  <rel>  (exit N)". It is the only place a failing file is
#    named outright instead of inferred from the line above it.
# 2. The fallback heuristic for a plain `bun test` capture: a "  <rel> ... "
#    line followed by "FAIL (n pass, m fail)". A "(retry) ..." line breaks the
#    pattern, so this is only used when the explicit block is absent.
#
# Either way the "(fail)" lines are the named tests, printed after the file list.
# A file that fails in both the parallel pass and the serial retry prints its
# tests twice; only the first copy is kept.
#
# The gh prefix is stripped in awk rather than sed: `\t` is a literal "t" in a
# BSD sed ERE, so the prefix never matched and every gh-prefixed line looked
# like a test name.
awk -v max="${max}" '
  function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }

  {
    line = $0

    # Runner logs come off the API with SGR colour codes in them ("\033[36;1m").
    # Left in, they land in the issue body and split a test name away from its
    # "(fail)" marker. Drop them before anything is matched.
    gsub(/\033\[[0-9;]*[A-Za-z]/, "", line)

    # "<job>\t<step>\t<timestamp> " (gh run view --log-failed)
    if (line ~ /^[^\t]*\t[^\t]*\t[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z /) {
      sub(/^[^\t]*\t[^\t]*\t[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z /, "", line)
    }
    # "<timestamp> " (gh api .../actions/jobs/<id>/logs)
    if (line ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z /) {
      sub(/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z /, "", line)
    }

    # 1. The explicit "Failed files (N):" block.
    if (line ~ /^Failed files \([0-9]+\):/) { in_failed = 1; next }
    if (in_failed) {
      if (line ~ /^[[:space:]]+[^[:space:]].*\.test\.tsx?[[:space:]]+\(exit [0-9]+\)$/) {
        f = trim(line)
        sub(/[[:space:]]+\(exit [0-9]+\)$/, "", f)
        if (!(f in explicit)) { explicit[f] = 1; explicit_order[++explicit_n] = f }
        next
      }
      if (line ~ /^[^[:space:]]/) in_failed = 0
    }

    # 2. Fallback: "  <rel> ... " then "FAIL (n pass, m fail)".
    if (line ~ /\.test\.tsx?[[:space:]]*\.\.\./) {
      file = trim(line)
      sub(/[[:space:]]*\.\.\..*/, "", file)
      next
    }
    if (line ~ /^FAIL \(/) {
      if (file != "" && !(file in heuristic)) { heuristic[file] = 1; heuristic_order[++heuristic_n] = file }
      file = ""
      next
    }
    # A failed result line. A file that fails in both the parallel pass and the
    # serial retry prints its tests twice; keep the first copy. The
    # "✗ 1 package(s) had test failures" line is the run summary, not a test.
    if (line ~ /\(fail\)|✗/ && line !~ /^✗[[:space:]]+[0-9]+[[:space:]]+package/) {
      t = trim(line)
      key = t
      sub(/[[:space:]]*\[[0-9.]+ms\]$/, "", key)
      if (!(key in seen_fail)) { seen_fail[key] = 1; fail_lines[++fail_n] = "  " t }
      next
    }
  }

  END {
    n = 0
    if (explicit_n > 0) {
      for (i = 1; i <= explicit_n; i++) {
        printf "FAIL %s\n", explicit_order[i]
        if (++n >= max) exit
      }
    } else {
      for (i = 1; i <= heuristic_n; i++) {
        printf "FAIL %s\n", heuristic_order[i]
        if (++n >= max) exit
      }
    }
    for (i = 1; i <= fail_n; i++) {
      printf "%s\n", fail_lines[i]
      if (++n >= max) exit
    }
  }
' "${log}"
