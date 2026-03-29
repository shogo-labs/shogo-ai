// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bug Fix Discipline Evals — Mini SWE-bench Style
 *
 * Tests the agent's ability to fix bugs in small codebases with test suites.
 * Validates the full discipline chain: explore -> hypothesize -> fix -> verify.
 *
 * Each eval seeds workspace files with a small module containing a known bug
 * and a test file. The agent must fix the bug without modifying tests,
 * creating throwaway files, or making unnecessarily large changes.
 *
 * Track: --track bug-fix
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, neverUsedTool, toolCallCount, toolCallArgsContain, execCommandContains } from './eval-helpers'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function readBeforeFirstEdit(r: EvalResult): boolean {
  const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
  if (editIdx === -1) return true
  return r.toolCalls.slice(0, editIdx).some(
    t => t.name === 'read_file' || t.name === 'grep',
  )
}

function neverWroteFile(r: EvalResult, pathPattern: RegExp): boolean {
  return !r.toolCalls.some(t =>
    (t.name === 'write_file' || t.name === 'edit_file') &&
    pathPattern.test(String((t.input as any).path ?? '')),
  )
}

function neverCreatedThrowawayFiles(r: EvalResult): boolean {
  const throwawayPatterns = [
    /debug/i, /reproduce/i, /scratch/i, /tmp_/i, /temp_/i, /check_/i, /verify_/i, /test_fix/i,
  ]
  return !r.toolCalls
    .filter(t => t.name === 'write_file')
    .some(t => {
      const path = String((t.input as any).path ?? '')
      return throwawayPatterns.some(p => p.test(path))
    })
}

function ranTests(r: EvalResult): boolean {
  return r.toolCalls
    .filter(t => t.name === 'exec')
    .some(t => {
      const cmd = String((t.input as any).command ?? '').toLowerCase()
      return cmd.includes('pytest') || cmd.includes('python -m pytest') ||
        cmd.includes('node --test') || cmd.includes('jest') || cmd.includes('vitest') ||
        cmd.includes('python test_') || cmd.includes('python -m unittest')
    })
}

function editedOnlyTargetFile(r: EvalResult, targetPath: string): boolean {
  const editedPaths = r.toolCalls
    .filter(t => t.name === 'edit_file' || t.name === 'write_file')
    .map(t => String((t.input as any).path ?? ''))
    .filter(p => p.length > 0)
  return editedPaths.length > 0 && editedPaths.every(p => p.includes(targetPath))
}

// ---------------------------------------------------------------------------
// Workspace file fixtures
// ---------------------------------------------------------------------------

const PY_MATH_UTILS = `def average(numbers):
    """Return the average of a list of numbers."""
    total = 0
    for n in numbers:
        total += n
    return total / len(numbers)


def median(numbers):
    """Return the median of a list of numbers."""
    sorted_nums = sorted(numbers)
    n = len(sorted_nums)
    mid = n // 2
    if n % 2 == 0:
        return (sorted_nums[mid - 1] + sorted_nums[mid]) / 2
    return sorted_nums[mid]


def percentile(numbers, p):
    """Return the p-th percentile of a list of numbers (0-100)."""
    if not numbers:
        raise ValueError("numbers must not be empty")
    sorted_nums = sorted(numbers)
    k = (p / 100) * len(sorted_nums)
    idx = int(k)
    if idx >= len(sorted_nums):
        idx = len(sorted_nums) - 1
    return sorted_nums[idx]
`

const PY_MATH_UTILS_TEST = `import pytest
from math_utils import average, median, percentile


def test_average_basic():
    assert average([1, 2, 3]) == 2.0


def test_average_single():
    assert average([5]) == 5.0


def test_average_empty():
    with pytest.raises(ZeroDivisionError):
        average([])


def test_median_odd():
    assert median([3, 1, 2]) == 2


def test_median_even():
    assert median([1, 2, 3, 4]) == 2.5


def test_median_single():
    assert median([7]) == 7


def test_percentile_50th():
    assert percentile([1, 2, 3, 4, 5], 50) == 3


def test_percentile_0th():
    assert percentile([10, 20, 30], 0) == 10


def test_percentile_100th():
    assert percentile([10, 20, 30], 100) == 30


def test_percentile_empty():
    with pytest.raises(ValueError):
        percentile([], 50)
`

const JS_STRING_UTILS = `/**
 * String utility functions.
 */

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function truncate(str, maxLength, suffix) {
  suffix = suffix || '...';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

function countWords(str) {
  if (!str || !str.trim()) return 0;
  return str.split(' ').length;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { capitalize, truncate, countWords, slugify };
`

const JS_STRING_UTILS_TEST = `const { capitalize, truncate, countWords, slugify } = require('./string_utils');

describe('capitalize', () => {
  test('capitalizes first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
  });
  test('handles empty string', () => {
    expect(capitalize('')).toBe('');
  });
  test('handles single char', () => {
    expect(capitalize('a')).toBe('A');
  });
});

describe('truncate', () => {
  test('does not truncate short strings', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });
  test('truncates long strings with default suffix', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });
  test('truncates with custom suffix', () => {
    expect(truncate('hello world', 7, '~')).toBe('hello ~');
  });
});

describe('countWords', () => {
  test('counts words', () => {
    expect(countWords('hello world')).toBe(2);
  });
  test('handles multiple spaces', () => {
    expect(countWords('hello   world   foo')).toBe(3);
  });
  test('handles empty string', () => {
    expect(countWords('')).toBe(0);
  });
  test('handles whitespace only', () => {
    expect(countWords('   ')).toBe(0);
  });
});

describe('slugify', () => {
  test('basic slugify', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
  test('strips special chars', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });
  test('handles multiple separators', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });
});
`

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const BUG_FIX_EVALS: AgentEval[] = [
  {
    id: 'bug-fix-py-empty-list',
    name: 'Fix Python average() to handle empty list gracefully',
    category: 'code-agent',
    level: 2,
    input: [
      'The `average()` function in `math_utils.py` crashes with a ZeroDivisionError when called with an empty list.',
      'The test suite expects this behavior (test_average_empty), but the `percentile()` function shows the preferred pattern:',
      'raise a ValueError with a descriptive message instead of letting the raw ZeroDivisionError propagate.',
      '',
      'Fix `average()` so it raises `ValueError("numbers must not be empty")` for empty input.',
      'Run the tests after fixing to make sure everything passes.',
    ].join('\n'),
    workspaceFiles: {
      'math_utils.py': PY_MATH_UTILS,
      'test_math_utils.py': PY_MATH_UTILS_TEST.replace(
        'def test_average_empty():\n    with pytest.raises(ZeroDivisionError):\n        average([])',
        'def test_average_empty():\n    with pytest.raises(ValueError, match="numbers must not be empty"):\n        average([])',
      ),
    },
    validationCriteria: [
      {
        id: 'read-before-edit',
        description: 'Agent reads the file (read_file or grep) before editing',
        points: 3,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-source-file',
        description: 'Agent edited math_utils.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'math_utils.py'),
      },
      {
        id: 'did-not-modify-tests',
        description: 'Agent did not modify the test file',
        points: 3,
        phase: 'execution',
        validate: (r) => neverWroteFile(r, /test_math_utils/),
      },
      {
        id: 'ran-tests',
        description: 'Agent ran the test suite to verify the fix',
        points: 4,
        phase: 'execution',
        validate: (r) => ranTests(r),
      },
      {
        id: 'no-throwaway-files',
        description: 'Agent did not create debug/reproduce scripts',
        points: 2,
        phase: 'execution',
        validate: (r) => neverCreatedThrowawayFiles(r),
      },
    ],
    antiPatterns: [
      'Created debug or reproduce scripts',
      'Modified test files',
      'Tool loop or repeated identical calls',
    ],
    maxScore: 15,
  },

  {
    id: 'bug-fix-js-word-count',
    name: 'Fix JS countWords() to handle multiple spaces',
    category: 'code-agent',
    level: 2,
    input: [
      'The `countWords()` function in `string_utils.js` incorrectly counts words when there are multiple consecutive spaces.',
      'For example, `countWords("hello   world   foo")` returns 5 instead of 3 because it splits on single spaces,',
      'creating empty strings in the array.',
      '',
      'Fix the function so it handles multiple consecutive spaces correctly.',
      'The test file is `string_utils.test.js` — run the tests to verify.',
    ].join('\n'),
    workspaceFiles: {
      'string_utils.js': JS_STRING_UTILS,
      'string_utils.test.js': JS_STRING_UTILS_TEST,
    },
    validationCriteria: [
      {
        id: 'read-before-edit',
        description: 'Agent reads the file before editing',
        points: 3,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-source-file',
        description: 'Agent edited string_utils.js (not the test)',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'string_utils.js'),
      },
      {
        id: 'only-edited-source',
        description: 'Agent only edited the source file, not the test',
        points: 3,
        phase: 'execution',
        validate: (r) => neverWroteFile(r, /string_utils\.test/),
      },
      {
        id: 'ran-tests',
        description: 'Agent ran the test suite',
        points: 4,
        phase: 'execution',
        validate: (r) => ranTests(r),
      },
      {
        id: 'no-throwaway-files',
        description: 'Agent did not create throwaway scripts',
        points: 2,
        phase: 'execution',
        validate: (r) => neverCreatedThrowawayFiles(r),
      },
    ],
    antiPatterns: [
      'Created debug or reproduce scripts',
      'Modified test files',
    ],
    maxScore: 15,
  },

  {
    id: 'bug-fix-py-off-by-one',
    name: 'Fix Python percentile() off-by-one for 100th percentile',
    category: 'code-agent',
    level: 3,
    input: [
      'The `percentile()` function in `math_utils.py` has a subtle off-by-one error.',
      'When computing the 100th percentile, `k = (100/100) * len(sorted_nums) = len(sorted_nums)`,',
      'and `idx = int(k) = len(sorted_nums)`, which is out of bounds. The current code clamps',
      'it with `if idx >= len(sorted_nums): idx = len(sorted_nums) - 1`, which returns the',
      'correct value for the 100th percentile case.',
      '',
      'However, the real bug is for intermediate percentiles: `int(k)` truncates instead of',
      'rounding, so `percentile([1,2,3,4,5], 50)` computes `k=2.5`, `idx=2`, returning',
      '`sorted_nums[2] = 3` when linear interpolation would give `2.5`.',
      '',
      'For this codebase, the convention is nearest-rank: `idx = max(0, int(math.ceil(k)) - 1)`.',
      'Fix the percentile function to use ceiling-based nearest-rank.',
      'Run the tests afterward.',
    ].join('\n'),
    workspaceFiles: {
      'math_utils.py': PY_MATH_UTILS,
      'test_math_utils.py': PY_MATH_UTILS_TEST.replace(
        'def test_average_empty():\n    with pytest.raises(ZeroDivisionError):\n        average([])',
        'def test_average_empty():\n    with pytest.raises(ZeroDivisionError):\n        average([])',
      ).replace(
        "def test_percentile_50th():\n    assert percentile([1, 2, 3, 4, 5], 50) == 3",
        "def test_percentile_50th():\n    assert percentile([1, 2, 3, 4, 5], 50) == 3",
      ),
    },
    validationCriteria: [
      {
        id: 'read-before-edit',
        description: 'Agent reads math_utils.py before editing',
        points: 3,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-source',
        description: 'Agent edited math_utils.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'math_utils.py'),
      },
      {
        id: 'only-edited-source',
        description: 'Agent edited only the source file',
        points: 3,
        phase: 'execution',
        validate: (r) => editedOnlyTargetFile(r, 'math_utils.py'),
      },
      {
        id: 'ran-tests',
        description: 'Agent ran the test suite',
        points: 4,
        phase: 'execution',
        validate: (r) => ranTests(r),
      },
      {
        id: 'minimal-edit',
        description: 'Agent used edit_file (not write_file to rewrite the whole file)',
        points: 2,
        phase: 'execution',
        validate: (r) => usedTool(r, 'edit_file') && !toolCallArgsContain(r, 'write_file', 'math_utils.py'),
      },
    ],
    antiPatterns: [
      'Created debug or reproduce scripts',
      'Modified test files',
    ],
    maxScore: 15,
  },

  {
    id: 'bug-fix-py-explore-first',
    name: 'Fix bug in unfamiliar repo structure using exploration',
    category: 'code-agent',
    level: 3,
    input: [
      'There is a bug in the `format_name` function in this project.',
      'When given a name with extra whitespace like "  John   Doe  ", it should return "John Doe"',
      'but instead it returns "  John   Doe  " with the whitespace preserved.',
      '',
      'Find the bug and fix it. Run the tests to verify.',
    ].join('\n'),
    workspaceFiles: {
      'src/utils/formatting.py': `def format_name(name):
    """Format a person's name: capitalize each word, strip extra whitespace."""
    if not name:
        return ""
    parts = name.split(" ")
    return " ".join(p.capitalize() for p in parts)
`,
      'src/utils/__init__.py': 'from .formatting import format_name\n',
      'src/__init__.py': '',
      'tests/test_formatting.py': `import pytest
from src.utils.formatting import format_name


def test_basic_name():
    assert format_name("john doe") == "John Doe"


def test_already_capitalized():
    assert format_name("John Doe") == "John Doe"


def test_extra_whitespace():
    assert format_name("  john   doe  ") == "John Doe"


def test_empty():
    assert format_name("") == ""


def test_none():
    assert format_name(None) == ""
`,
    },
    validationCriteria: [
      {
        id: 'explored-structure',
        description: 'Agent used ls, glob, or grep to understand the project before editing',
        points: 3,
        phase: 'intention',
        validate: (r) => {
          const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
          if (editIdx === -1) return false
          return r.toolCalls.slice(0, editIdx).some(
            t => t.name === 'ls' || t.name === 'glob' || t.name === 'grep',
          )
        },
      },
      {
        id: 'read-before-edit',
        description: 'Agent read the source file before editing',
        points: 3,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-correct-file',
        description: 'Agent edited formatting.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'formatting.py'),
      },
      {
        id: 'did-not-modify-tests',
        description: 'Agent did not modify test files',
        points: 3,
        phase: 'execution',
        validate: (r) => neverWroteFile(r, /test_formatting/),
      },
      {
        id: 'ran-tests',
        description: 'Agent ran the test suite',
        points: 4,
        phase: 'execution',
        validate: (r) => ranTests(r),
      },
      {
        id: 'no-throwaway-files',
        description: 'No debug/reproduce scripts created',
        points: 2,
        phase: 'execution',
        validate: (r) => neverCreatedThrowawayFiles(r),
      },
    ],
    antiPatterns: [
      'Created debug or reproduce scripts',
      'Modified test files',
      'Tool loop or repeated identical calls',
    ],
    maxScore: 18,
  },
]
