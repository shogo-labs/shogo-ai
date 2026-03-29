// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coding Discipline Evals
 *
 * Tests agent adherence to coding best practices drawn from the
 * CODE_AGENT_GENERAL_GUIDE and Cursor-style agent patterns:
 *
 * A. Read-before-edit — agent must read/grep before any edit_file call
 * B. Verify-after-edit — agent must run tests or check output after changes
 * C. Minimal change — agent should use edit_file (not write_file rewrite) and
 *    avoid touching unrelated code
 * D. Tool efficiency — agent should use grep/glob over exec(cat/grep),
 *    and not create throwaway scripts
 *
 * Track: --track coding-discipline
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

function usedExplorationBeforeEdit(r: EvalResult): boolean {
  const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file' || t.name === 'write_file')
  if (editIdx === -1) return false
  return r.toolCalls.slice(0, editIdx).some(
    t => t.name === 'ls' || t.name === 'glob' || t.name === 'grep' || t.name === 'read_file',
  )
}

function ranTests(r: EvalResult): boolean {
  return r.toolCalls
    .filter(t => t.name === 'exec')
    .some(t => {
      const cmd = String((t.input as any).command ?? '').toLowerCase()
      return cmd.includes('pytest') || cmd.includes('python -m pytest') ||
        cmd.includes('node --test') || cmd.includes('jest') || cmd.includes('vitest') ||
        cmd.includes('python -m unittest')
    })
}

function ranTestsAfterEdit(r: EvalResult): boolean {
  const lastEditIdx = findLastIndex(r.toolCalls, t => t.name === 'edit_file' || t.name === 'write_file')
  if (lastEditIdx === -1) return false
  return r.toolCalls.slice(lastEditIdx + 1).some(t => {
    if (t.name !== 'exec') return false
    const cmd = String((t.input as any).command ?? '').toLowerCase()
    return cmd.includes('pytest') || cmd.includes('python -m pytest') ||
      cmd.includes('node --test') || cmd.includes('jest') || cmd.includes('vitest') ||
      cmd.includes('python -m unittest')
  })
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}

function neverCreatedThrowawayFiles(r: EvalResult): boolean {
  const throwawayPatterns = [
    /debug/i, /reproduce/i, /scratch/i, /tmp_/i, /temp_/i, /check_/i, /verify_script/i,
  ]
  return !r.toolCalls
    .filter(t => t.name === 'write_file')
    .some(t => {
      const path = String((t.input as any).path ?? '')
      return throwawayPatterns.some(p => p.test(path))
    })
}

function neverUsedExecCat(r: EvalResult): boolean {
  return !r.toolCalls
    .filter(t => t.name === 'exec')
    .some(t => {
      const cmd = String((t.input as any).command ?? '').toLowerCase()
      return /\bcat\s+/.test(cmd) && !cmd.includes('.build.log')
    })
}

function neverUsedExecGrep(r: EvalResult): boolean {
  return !r.toolCalls
    .filter(t => t.name === 'exec')
    .some(t => {
      const cmd = String((t.input as any).command ?? '').toLowerCase()
      return /\bgrep\s+/.test(cmd) || /\brg\s+/.test(cmd)
    })
}

function usedEditNotWrite(r: EvalResult, pathSubstring: string): boolean {
  const usedEdit = r.toolCalls.some(t =>
    t.name === 'edit_file' && String((t.input as any).path ?? '').includes(pathSubstring),
  )
  const usedWrite = r.toolCalls.some(t =>
    t.name === 'write_file' && String((t.input as any).path ?? '').includes(pathSubstring),
  )
  return usedEdit && !usedWrite
}

function editFileCount(r: EvalResult): number {
  return r.toolCalls.filter(t => t.name === 'edit_file').length
}

// ---------------------------------------------------------------------------
// Workspace fixtures
// ---------------------------------------------------------------------------

const PY_CONFIG_PARSER = `import json


class ConfigParser:
    """Reads and validates JSON configuration files."""

    def __init__(self, path):
        self.path = path
        self._data = None

    def load(self):
        with open(self.path, 'r') as f:
            self._data = json.load(f)
        return self

    def get(self, key, default=None):
        if self._data is None:
            raise RuntimeError("Config not loaded. Call load() first.")
        return self._data.get(key, default)

    def get_int(self, key, default=0):
        val = self.get(key, default)
        return int(val)

    def get_bool(self, key, default=False):
        val = self.get(key, default)
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.lower() in ('true', '1', 'yes')
        return bool(val)

    def keys(self):
        if self._data is None:
            raise RuntimeError("Config not loaded. Call load() first.")
        return list(self._data.keys())

    def validate(self, required_keys):
        missing = [k for k in required_keys if k not in self._data]
        if missing:
            raise ValueError(f"Missing required keys: {missing}")
        return True
`

const PY_CONFIG_PARSER_TEST = `import pytest
import json
import tempfile
import os

from config_parser import ConfigParser


@pytest.fixture
def config_file(tmp_path):
    data = {"host": "localhost", "port": 8080, "debug": True, "name": "test-app"}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_load_and_get(config_file):
    cfg = ConfigParser(config_file).load()
    assert cfg.get("host") == "localhost"
    assert cfg.get("port") == 8080


def test_get_default(config_file):
    cfg = ConfigParser(config_file).load()
    assert cfg.get("missing", "fallback") == "fallback"


def test_get_int(config_file):
    cfg = ConfigParser(config_file).load()
    assert cfg.get_int("port") == 8080


def test_get_bool(config_file):
    cfg = ConfigParser(config_file).load()
    assert cfg.get_bool("debug") is True


def test_keys(config_file):
    cfg = ConfigParser(config_file).load()
    assert set(cfg.keys()) == {"host", "port", "debug", "name"}


def test_validate_pass(config_file):
    cfg = ConfigParser(config_file).load()
    assert cfg.validate(["host", "port"]) is True


def test_validate_fail(config_file):
    cfg = ConfigParser(config_file).load()
    with pytest.raises(ValueError, match="Missing required keys"):
        cfg.validate(["host", "nonexistent"])


def test_get_without_load(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{}")
    cfg = ConfigParser(str(path))
    with pytest.raises(RuntimeError, match="Config not loaded"):
        cfg.get("key")
`

const JS_CALCULATOR = `class Calculator {
  constructor() {
    this.history = [];
  }

  add(a, b) {
    const result = a + b;
    this.history.push({ op: 'add', a, b, result });
    return result;
  }

  subtract(a, b) {
    const result = a - b;
    this.history.push({ op: 'subtract', a, b, result });
    return result;
  }

  multiply(a, b) {
    const result = a * b;
    this.history.push({ op: 'multiply', a, b, result });
    return result;
  }

  divide(a, b) {
    if (b === 0) throw new Error('Division by zero');
    const result = a / b;
    this.history.push({ op: 'divide', a, b, result });
    return result;
  }

  getHistory() {
    return [...this.history];
  }

  clearHistory() {
    this.history = [];
  }

  getLastResult() {
    if (this.history.length === 0) return null;
    return this.history[this.history.length - 1].result;
  }
}

module.exports = { Calculator };
`

const JS_CALCULATOR_TEST = `const { Calculator } = require('./calculator');

describe('Calculator', () => {
  let calc;

  beforeEach(() => {
    calc = new Calculator();
  });

  test('add', () => {
    expect(calc.add(2, 3)).toBe(5);
  });

  test('subtract', () => {
    expect(calc.subtract(10, 4)).toBe(6);
  });

  test('multiply', () => {
    expect(calc.multiply(3, 4)).toBe(12);
  });

  test('divide', () => {
    expect(calc.divide(10, 2)).toBe(5);
  });

  test('divide by zero', () => {
    expect(() => calc.divide(1, 0)).toThrow('Division by zero');
  });

  test('history tracking', () => {
    calc.add(1, 2);
    calc.subtract(5, 3);
    const history = calc.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].op).toBe('add');
    expect(history[1].op).toBe('subtract');
  });

  test('getLastResult', () => {
    calc.add(1, 2);
    calc.multiply(3, 4);
    expect(calc.getLastResult()).toBe(12);
  });

  test('getLastResult empty', () => {
    expect(calc.getLastResult()).toBeNull();
  });

  test('clearHistory', () => {
    calc.add(1, 2);
    calc.clearHistory();
    expect(calc.getHistory()).toHaveLength(0);
  });
});
`

const MULTI_FILE_CODEBASE = {
  'src/models/user.py': `class User:
    def __init__(self, name, email, role="member"):
        self.name = name
        self.email = email
        self.role = role

    def is_admin(self):
        return self.role == "admin"

    def display_name(self):
        return f"{self.name} <{self.email}>"
`,
  'src/models/team.py': `class Team:
    def __init__(self, name):
        self.name = name
        self.members = []

    def add_member(self, user):
        self.members.append(user)

    def remove_member(self, email):
        self.members = [m for m in self.members if m.email != email]

    def get_admins(self):
        return [m for m in self.members if m.is_admin()]

    def size(self):
        return len(self.members)
`,
  'src/models/__init__.py': 'from .user import User\nfrom .team import Team\n',
  'src/__init__.py': '',
  'src/services/auth.py': `from src.models import User


def authenticate(users, email, password):
    """Authenticate a user by email. Password check is stubbed."""
    for user in users:
        if user.email == email:
            return user
    return None


def authorize(user, required_role):
    """Check if user has the required role."""
    if required_role == "admin":
        return user.is_admin()
    return True
`,
  'src/services/__init__.py': '',
  'tests/test_auth.py': `import pytest
from src.models import User
from src.services.auth import authenticate, authorize


@pytest.fixture
def users():
    return [
        User("Alice", "alice@example.com", "admin"),
        User("Bob", "bob@example.com", "member"),
    ]


def test_authenticate_found(users):
    user = authenticate(users, "alice@example.com", "pass")
    assert user is not None
    assert user.name == "Alice"


def test_authenticate_not_found(users):
    user = authenticate(users, "unknown@example.com", "pass")
    assert user is None


def test_authorize_admin(users):
    alice = users[0]
    assert authorize(alice, "admin") is True


def test_authorize_non_admin(users):
    bob = users[1]
    assert authorize(bob, "admin") is False


def test_authorize_member_role(users):
    bob = users[1]
    assert authorize(bob, "member") is True
`,
}

// ---------------------------------------------------------------------------
// A. Read-Before-Edit Discipline
// ---------------------------------------------------------------------------

const READ_DISCIPLINE_EVALS: AgentEval[] = [
  {
    id: 'discipline-read-before-edit-ambiguous',
    name: 'Read before edit with ambiguous file locations',
    category: 'code-agent',
    level: 2,
    input: [
      'The `authenticate` function has a bug: it should be case-insensitive when matching emails.',
      'For example, looking up "Alice@Example.com" should find the user with "alice@example.com".',
      'Find and fix this bug, then run the tests.',
    ].join('\n'),
    workspaceFiles: MULTI_FILE_CODEBASE,
    validationCriteria: [
      {
        id: 'explored-before-editing',
        description: 'Agent explored the codebase (ls/glob/grep) before editing',
        points: 3,
        phase: 'intention',
        validate: (r) => usedExplorationBeforeEdit(r),
      },
      {
        id: 'read-before-edit',
        description: 'Agent read the target file before editing',
        points: 4,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-correct-file',
        description: 'Agent edited auth.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'auth.py'),
      },
      {
        id: 'no-throwaway-files',
        description: 'Agent did not create throwaway scripts to test',
        points: 3,
        phase: 'execution',
        validate: (r) => neverCreatedThrowawayFiles(r),
      },
    ],
    antiPatterns: [
      'Created debug or reproduce scripts',
    ],
    maxScore: 13,
  },

  {
    id: 'discipline-grep-to-locate',
    name: 'Use grep to locate code before editing',
    category: 'code-agent',
    level: 2,
    input: [
      'The `display_name` method on the User class should format the name as "Name (email)"',
      'instead of "Name <email>". Find and fix it.',
    ].join('\n'),
    workspaceFiles: MULTI_FILE_CODEBASE,
    validationCriteria: [
      {
        id: 'used-grep-or-glob',
        description: 'Agent used grep or glob to find the function',
        points: 4,
        phase: 'intention',
        validate: (r) => {
          const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
          if (editIdx === -1) return false
          return r.toolCalls.slice(0, editIdx).some(
            t => t.name === 'grep' || t.name === 'glob',
          )
        },
      },
      {
        id: 'read-before-edit',
        description: 'Agent read user.py before editing',
        points: 3,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-correct-file',
        description: 'Agent edited user.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'user.py'),
      },
      {
        id: 'minimal-edit',
        description: 'Agent used edit_file (not write_file)',
        points: 3,
        phase: 'execution',
        validate: (r) => usedEditNotWrite(r, 'user.py'),
      },
    ],
    maxScore: 13,
  },
]

// ---------------------------------------------------------------------------
// B. Verify-After-Edit Discipline
// ---------------------------------------------------------------------------

const VERIFY_DISCIPLINE_EVALS: AgentEval[] = [
  {
    id: 'discipline-verify-after-fix',
    name: 'Run tests after fixing a bug',
    category: 'code-agent',
    level: 2,
    input: [
      'The `get_int` method in `config_parser.py` crashes when the value is a float string like "3.14".',
      'It does `int(val)` which raises ValueError for "3.14".',
      'Fix it to truncate floats (i.e., `int(float(val))`).',
      'Run the tests to verify your fix.',
    ].join('\n'),
    workspaceFiles: {
      'config_parser.py': PY_CONFIG_PARSER,
      'test_config_parser.py': PY_CONFIG_PARSER_TEST + `

def test_get_int_float_string(tmp_path):
    import json
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"rate": "3.14"}))
    cfg = ConfigParser(str(path)).load()
    assert cfg.get_int("rate") == 3
`,
    },
    validationCriteria: [
      {
        id: 'read-before-edit',
        description: 'Agent read the file before editing',
        points: 2,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'edited-source',
        description: 'Agent edited config_parser.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'config_parser.py'),
      },
      {
        id: 'ran-tests-after-edit',
        description: 'Agent ran tests AFTER making the edit',
        points: 5,
        phase: 'execution',
        validate: (r) => ranTestsAfterEdit(r),
      },
      {
        id: 'did-not-modify-tests',
        description: 'Agent did not modify the test file',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          return !r.toolCalls.some(t =>
            (t.name === 'edit_file' || t.name === 'write_file') &&
            String((t.input as any).path ?? '').includes('test_config_parser'),
          )
        },
      },
    ],
    antiPatterns: [
      'Modified test files',
    ],
    maxScore: 13,
  },

  {
    id: 'discipline-iterate-on-failure',
    name: 'Iterate when first fix attempt fails tests',
    category: 'code-agent',
    level: 3,
    input: [
      'The `validate` method in `config_parser.py` crashes with a TypeError when `_data` is None',
      '(i.e., when `load()` was not called before `validate()`).',
      'It should raise RuntimeError("Config not loaded. Call load() first.") like `get()` and `keys()` do.',
      'Fix it and run the tests.',
    ].join('\n'),
    workspaceFiles: {
      'config_parser.py': PY_CONFIG_PARSER,
      'test_config_parser.py': PY_CONFIG_PARSER_TEST + `

def test_validate_without_load(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{}")
    cfg = ConfigParser(str(path))
    with pytest.raises(RuntimeError, match="Config not loaded"):
        cfg.validate(["key"])
`,
    },
    validationCriteria: [
      {
        id: 'edited-source',
        description: 'Agent edited config_parser.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'config_parser.py'),
      },
      {
        id: 'ran-tests',
        description: 'Agent ran the test suite',
        points: 4,
        phase: 'execution',
        validate: (r) => ranTests(r),
      },
      {
        id: 'ran-tests-after-edit',
        description: 'Agent ran tests after the edit, not just before',
        points: 3,
        phase: 'execution',
        validate: (r) => ranTestsAfterEdit(r),
      },
      {
        id: 'minimal-edit',
        description: 'Agent used edit_file not write_file',
        points: 3,
        phase: 'execution',
        validate: (r) => usedEditNotWrite(r, 'config_parser.py'),
      },
    ],
    maxScore: 13,
  },
]

// ---------------------------------------------------------------------------
// C. Minimal Change Discipline
// ---------------------------------------------------------------------------

const MINIMAL_CHANGE_EVALS: AgentEval[] = [
  {
    id: 'discipline-minimal-one-line-fix',
    name: 'Make a one-line fix instead of rewriting',
    category: 'code-agent',
    level: 2,
    input: [
      'The `divide` method in `calculator.js` should round the result to 10 decimal places',
      'to avoid floating point issues (e.g., `1/3` should be `0.3333333333` not `0.3333333333333333`).',
      'Fix just the divide method. Do not touch any other method.',
    ].join('\n'),
    workspaceFiles: {
      'calculator.js': JS_CALCULATOR,
      'calculator.test.js': JS_CALCULATOR_TEST.replace(
        "test('divide', () => {\n    expect(calc.divide(10, 2)).toBe(5);\n  });",
        "test('divide', () => {\n    expect(calc.divide(10, 2)).toBe(5);\n  });\n\n  test('divide precision', () => {\n    expect(calc.divide(1, 3)).toBe(0.3333333333);\n  });",
      ),
    },
    validationCriteria: [
      {
        id: 'used-edit-not-write',
        description: 'Agent used edit_file, not write_file, on calculator.js',
        points: 4,
        phase: 'execution',
        validate: (r) => usedEditNotWrite(r, 'calculator.js'),
      },
      {
        id: 'few-edits',
        description: 'Agent made 3 or fewer edit_file calls total',
        points: 3,
        phase: 'execution',
        validate: (r) => editFileCount(r) <= 3,
      },
      {
        id: 'did-not-modify-tests',
        description: 'Agent did not modify the test file',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          return !r.toolCalls.some(t =>
            (t.name === 'edit_file' || t.name === 'write_file') &&
            String((t.input as any).path ?? '').includes('calculator.test'),
          )
        },
      },
      {
        id: 'read-before-edit',
        description: 'Agent read the file before editing',
        points: 2,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
    ],
    antiPatterns: [
      'Modified test files',
    ],
    maxScore: 12,
  },

  {
    id: 'discipline-no-unrelated-refactoring',
    name: 'Fix the bug without refactoring unrelated code',
    category: 'code-agent',
    level: 3,
    input: [
      'The `remove_member` method in `src/models/team.py` has a bug: it compares `m.email != email`',
      'but the comparison should be case-insensitive.',
      'Fix only the `remove_member` method. Do not change any other method or file.',
    ].join('\n'),
    workspaceFiles: MULTI_FILE_CODEBASE,
    validationCriteria: [
      {
        id: 'edited-correct-file',
        description: 'Agent edited team.py',
        points: 3,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'team.py'),
      },
      {
        id: 'used-edit-not-write',
        description: 'Agent used edit_file on team.py',
        points: 3,
        phase: 'execution',
        validate: (r) => usedEditNotWrite(r, 'team.py'),
      },
      {
        id: 'only-edited-team',
        description: 'Agent only edited team.py (no other source files)',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const editedPaths = r.toolCalls
            .filter(t => t.name === 'edit_file' || t.name === 'write_file')
            .map(t => String((t.input as any).path ?? ''))
            .filter(p => p.length > 0)
          return editedPaths.length > 0 && editedPaths.every(p => p.includes('team.py'))
        },
      },
      {
        id: 'read-before-edit',
        description: 'Agent read the file before editing',
        points: 2,
        phase: 'execution',
        validate: (r) => readBeforeFirstEdit(r),
      },
    ],
    maxScore: 12,
  },
]

// ---------------------------------------------------------------------------
// D. Tool Efficiency Discipline
// ---------------------------------------------------------------------------

const TOOL_EFFICIENCY_EVALS: AgentEval[] = [
  {
    id: 'discipline-use-grep-not-exec',
    name: 'Use grep tool instead of exec(grep)',
    category: 'code-agent',
    level: 1,
    input: [
      'Find all places in this codebase where `is_admin` is used or defined.',
      'List each file and line. Do not make any changes.',
    ].join('\n'),
    workspaceFiles: MULTI_FILE_CODEBASE,
    validationCriteria: [
      {
        id: 'used-grep-tool',
        description: 'Agent used the grep tool (not exec with grep/rg)',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'grep'),
      },
      {
        id: 'did-not-exec-grep',
        description: 'Agent did not use exec to run grep/rg',
        points: 4,
        phase: 'execution',
        validate: (r) => neverUsedExecGrep(r),
      },
      {
        id: 'no-throwaway-files',
        description: 'Agent did not create scripts to search',
        points: 3,
        phase: 'execution',
        validate: (r) => neverCreatedThrowawayFiles(r),
      },
    ],
    maxScore: 12,
  },

  {
    id: 'discipline-use-read-not-cat',
    name: 'Use read_file instead of exec(cat)',
    category: 'code-agent',
    level: 1,
    input: [
      'Read the contents of `src/models/user.py` and `src/models/team.py` and summarize what classes they define.',
    ].join('\n'),
    workspaceFiles: MULTI_FILE_CODEBASE,
    validationCriteria: [
      {
        id: 'used-read-file',
        description: 'Agent used read_file to read the files',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'read_file'),
      },
      {
        id: 'did-not-exec-cat',
        description: 'Agent did not use exec(cat) to read files',
        points: 4,
        phase: 'execution',
        validate: (r) => neverUsedExecCat(r),
      },
      {
        id: 'mentioned-classes',
        description: 'Response mentions User and Team classes',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('user') && text.includes('team')
        },
      },
    ],
    maxScore: 12,
  },

  {
    id: 'discipline-no-throwaway-investigation',
    name: 'Investigate with tools, not throwaway scripts',
    category: 'code-agent',
    level: 2,
    input: [
      'I\'m getting an error when calling `authenticate` with an email that has uppercase letters.',
      'Can you investigate whether the comparison is case-sensitive and tell me what you find?',
      'Do NOT make any changes yet — just investigate and report.',
    ].join('\n'),
    workspaceFiles: MULTI_FILE_CODEBASE,
    validationCriteria: [
      {
        id: 'used-grep-or-read',
        description: 'Agent used grep or read_file to investigate',
        points: 4,
        phase: 'execution',
        validate: (r) => usedTool(r, 'grep') || usedTool(r, 'read_file'),
      },
      {
        id: 'no-throwaway-files',
        description: 'Agent did not create throwaway scripts',
        points: 5,
        phase: 'execution',
        validate: (r) => neverCreatedThrowawayFiles(r),
      },
      {
        id: 'no-edits',
        description: 'Agent did not edit any files (investigation only)',
        points: 3,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'edit_file') && neverUsedTool(r, 'write_file'),
      },
    ],
    maxScore: 12,
  },
]

// ---------------------------------------------------------------------------
// Export combined
// ---------------------------------------------------------------------------

export const CODING_DISCIPLINE_EVALS: AgentEval[] = [
  ...READ_DISCIPLINE_EVALS,
  ...VERIFY_DISCIPLINE_EVALS,
  ...MINIMAL_CHANGE_EVALS,
  ...TOOL_EFFICIENCY_EVALS,
]
