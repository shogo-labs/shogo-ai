// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * edit_file Focused Eval Test Cases — Canvas V2 Agent
 *
 * Tests the v2 agent's ability to use the edit_file tool correctly
 * on canvas/*.ts files, targeting three key failure modes in production:
 *
 * 1. old_string not found — agent sends text that doesn't match the file
 * 2. Sequential edits — 2nd edit breaks because file changed from 1st
 * 3. Falls back to write_file — agent rewrites entire file instead of targeted edit
 *
 * All evals run in canvas code mode (canvasMode: 'code', activeMode: 'canvas')
 * so the v2 system prompt with edit_file guidance is active.
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, neverUsedTool, toolCallCount, usedToolSuccessfully } from './eval-helpers'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** True if edit_file was used on `path` and write_file was NOT used on that same path. */
function usedEditNotWrite(r: EvalResult, pathPattern: RegExp): boolean {
  const usedEdit = r.toolCalls.some(t =>
    t.name === 'edit_file' && pathPattern.test(String((t.input as any).path ?? ''))
  )
  const usedWrite = r.toolCalls.some(t =>
    t.name === 'write_file' && pathPattern.test(String((t.input as any).path ?? ''))
  )
  return usedEdit && !usedWrite
}

/** True if edit_file was called at least `minTimes` on a path matching the pattern. */
function editedFileTimes(r: EvalResult, pathPattern: RegExp, minTimes: number): boolean {
  const count = r.toolCalls.filter(t =>
    t.name === 'edit_file' && pathPattern.test(String((t.input as any).path ?? ''))
  ).length
  return count >= minTimes
}

/** True if any edit_file call's new_string contains `text` (case-insensitive). */
function editNewStringContains(r: EvalResult, text: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'edit_file')
    .some(t => {
      const ns = String((t.input as any).new_string ?? '').toLowerCase()
      return ns.includes(text.toLowerCase())
    })
}

/** True if any edit_file call's old_string contains `text` (case-insensitive). */
function editOldStringContains(r: EvalResult, text: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'edit_file')
    .some(t => {
      const os = String((t.input as any).old_string ?? '').toLowerCase()
      return os.includes(text.toLowerCase())
    })
}

/** True if the agent read the target file before its first edit_file call. */
function readBeforeFirstEdit(r: EvalResult): boolean {
  const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
  if (editIdx === -1) return true
  return r.toolCalls.slice(0, editIdx).some(
    t => t.name === 'read_file' || t.name === 'grep' || t.name === 'glob'
  )
}

/** All edit_file + write_file inputs as a single lowercase JSON string. */
function allEditInputsJson(r: EvalResult): string {
  return JSON.stringify(
    r.toolCalls
      .filter(t => t.name === 'edit_file' || t.name === 'write_file')
      .map(t => t.input)
  ).toLowerCase()
}

/** True if any edit_file or write_file output contains the text (checks the result). */
function anyFileOutputContains(r: EvalResult, text: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'edit_file' || t.name === 'write_file')
    .some(t => {
      const json = JSON.stringify(t.input ?? '').toLowerCase()
      return json.includes(text.toLowerCase())
    })
}

// ---------------------------------------------------------------------------
// Shared V2 config — every eval seeds canvasMode: 'code' + activeMode: 'canvas'
// ---------------------------------------------------------------------------

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  canvasMode: 'code',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

// ---------------------------------------------------------------------------
// Pre-seeded canvas files (h() syntax, var declarations, no imports/exports)
// ---------------------------------------------------------------------------

const CANVAS_PAGE = `return h('div', { className: 'p-4' }, [
  h('h1', { key: 'title', className: 'text-2xl font-bold' }, 'Welcome'),
  h('p', { key: 'desc', className: 'text-muted-foreground' }, 'This is the main page of the application.'),
])`

const CANVAS_TEAM = `return h('div', { className: 'p-6 space-y-4' }, [
  h('h1', { key: 'title', className: 'text-3xl font-bold' }, 'Team Dashboard'),
  h(Card, { key: 'card' }, [
    h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'Members')),
    h(CardContent, { key: 'content' }, h('p', {}, '5 active members')),
  ]),
])`

const CANVAS_ITEMS = `var _d = useState([])
var items = _d[0], setItems = _d[1]

function loadData() {
  fetch('/api/data')
    .then(function(r) { return r.json() })
    .then(function(d) { setItems(d) })
}

useEffect(function() { loadData() }, [])

return h('div', { className: 'p-4' }, [
  h('h1', { key: 'title' }, 'Items'),
  h(Button, { key: 'refresh', onClick: loadData }, 'Refresh'),
  h('ul', { key: 'list' },
    items.map(function(item) {
      return h('li', { key: item.id }, item.name)
    })
  ),
])`

const CANVAS_SETTINGS = `var config = {
  appName: 'MyApp',
  version: '1.0.0',
  theme: 'light',
  apiUrl: 'https://api.example.com',
  maxRetries: 3,
}

return h('div', { className: 'p-4 space-y-2' }, [
  h('h2', { key: 'title', className: 'text-xl font-bold' }, config.appName),
  h('p', { key: 'ver', className: 'text-sm text-muted-foreground' }, 'v' + config.version),
  h(Badge, { key: 'theme' }, config.theme),
  h('p', { key: 'url', className: 'text-xs' }, config.apiUrl),
])`

const CANVAS_FORM = `var _n = useState('')
var name = _n[0], setName = _n[1]
var _e = useState('')
var email = _e[0], setEmail = _e[1]
var _p = useState('')
var phone = _p[0], setPhone = _p[1]

return h('form', { className: 'space-y-4 p-4' }, [
  h('div', { key: 'name-field' }, [
    h(Label, { key: 'label', htmlFor: 'name' }, 'Name'),
    h(Input, {
      key: 'input',
      id: 'name',
      value: name,
      onChange: function(e) { setName(e.target.value) },
      placeholder: 'Enter your name',
    }),
  ]),
  h('div', { key: 'email-field' }, [
    h(Label, { key: 'label', htmlFor: 'email' }, 'Email'),
    h(Input, {
      key: 'input',
      id: 'email',
      type: 'email',
      value: email,
      onChange: function(e) { setEmail(e.target.value) },
      placeholder: 'Enter your email',
    }),
  ]),
  h('div', { key: 'phone-field' }, [
    h(Label, { key: 'label', htmlFor: 'phone' }, 'Phone'),
    h(Input, {
      key: 'input',
      id: 'phone',
      type: 'tel',
      value: phone,
      onChange: function(e) { setPhone(e.target.value) },
      placeholder: 'Enter your phone',
    }),
  ]),
  h(Button, { key: 'submit', type: 'submit' }, 'Submit'),
])`

const CANVAS_DASHBOARD = `var metrics = [
  { label: 'Users', value: 1200, trend: '+12%' },
  { label: 'Revenue', value: '$32K', trend: '+8%' },
  { label: 'Sessions', value: 890, trend: '+5%' },
]

return h('div', { className: 'flex flex-col gap-6 p-2' }, [
  h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Dashboard'),
  h(Row, { key: 'metrics', gap: 'md' },
    metrics.map(function(m, i) {
      return h(Metric, { key: i, label: m.label, value: m.value, trendValue: m.trend })
    })
  ),
])`

const LARGE_CANVAS_ADMIN = `var MAX_RETRIES = 3
var TIMEOUT_MS = 5000
var BASE_URL = 'https://api.example.com'

var _u = useState([])
var users = _u[0], setUsers = _u[1]
var _t = useState([])
var tasks = _t[0], setTasks = _t[1]
var _tab = useState('users')
var activeTab = _tab[0], setActiveTab = _tab[1]
var _loading = useState(true)
var loading = _loading[0], setLoading = _loading[1]
var _error = useState(null)
var error = _error[0], setError = _error[1]

function fetchUsers() {
  fetch(BASE_URL + '/api/users')
    .then(function(r) { return r.json() })
    .then(function(data) { setUsers(data); setLoading(false) })
    .catch(function(e) { setError(e.message); setLoading(false) })
}

function fetchTasks() {
  fetch(BASE_URL + '/api/tasks')
    .then(function(r) { return r.json() })
    .then(function(data) { setTasks(data); setLoading(false) })
    .catch(function(e) { setError(e.message); setLoading(false) })
}

useEffect(function() {
  fetchUsers()
  fetchTasks()
}, [])

if (loading) return h('div', { className: 'p-4' }, h(Skeleton, { className: 'h-64 w-full' }))
if (error) return h(Alert, { variant: 'destructive' }, h(AlertDescription, {}, error))

return h('div', { className: 'flex flex-col gap-6 p-2' }, [
  h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Admin Panel'),
  h(Row, { key: 'stats', gap: 'md' }, [
    h(Metric, { key: 'users', label: 'Users', value: users.length }),
    h(Metric, { key: 'tasks', label: 'Tasks', value: tasks.length }),
    h(Metric, { key: 'retries', label: 'Max Retries', value: MAX_RETRIES }),
    h(Metric, { key: 'timeout', label: 'Timeout', value: TIMEOUT_MS + 'ms' }),
  ]),
  h(Tabs, { key: 'tabs', value: activeTab, onValueChange: setActiveTab }, [
    h(TabsList, { key: 'list' }, [
      h(TabsTrigger, { key: 'users-tab', value: 'users' }, 'Users'),
      h(TabsTrigger, { key: 'tasks-tab', value: 'tasks' }, 'Tasks'),
    ]),
    h(TabsContent, { key: 'users-content', value: 'users' },
      h(Card, {}, [
        h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'All Users')),
        h(CardContent, { key: 'content' },
          h(Table, {}, [
            h(TableHeader, { key: 'thead' }, h(TableRow, {}, [
              h(TableHead, { key: 'name' }, 'Name'),
              h(TableHead, { key: 'email' }, 'Email'),
              h(TableHead, { key: 'role' }, 'Role'),
            ])),
            h(TableBody, { key: 'tbody' },
              users.map(function(u) {
                return h(TableRow, { key: u.id }, [
                  h(TableCell, { key: 'name' }, u.name),
                  h(TableCell, { key: 'email' }, u.email),
                  h(TableCell, { key: 'role' }, h(Badge, {}, u.role)),
                ])
              })
            ),
          ])
        ),
      ])
    ),
    h(TabsContent, { key: 'tasks-content', value: 'tasks' },
      h(Card, {}, [
        h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'All Tasks')),
        h(CardContent, { key: 'content' },
          h(Table, {}, [
            h(TableHeader, { key: 'thead' }, h(TableRow, {}, [
              h(TableHead, { key: 'title' }, 'Title'),
              h(TableHead, { key: 'assignee' }, 'Assignee'),
              h(TableHead, { key: 'status' }, 'Status'),
            ])),
            h(TableBody, { key: 'tbody' },
              tasks.map(function(t) {
                return h(TableRow, { key: t.id }, [
                  h(TableCell, { key: 'title' }, t.title),
                  h(TableCell, { key: 'assignee' }, t.assignee),
                  h(TableCell, { key: 'status' },
                    h(Badge, { variant: t.completed ? 'default' : 'outline' },
                      t.completed ? 'Done' : 'Pending'
                    )
                  ),
                ])
              })
            ),
          ])
        ),
      ])
    ),
  ]),
])`

const CANVAS_USER_CARD = `var user = data || { id: '1', name: 'Jane Doe', email: 'jane@example.com', role: 'admin', avatar: null }
var initials = user.name.split(' ').map(function(n) { return n[0] }).join('')

return h(Card, { className: 'hover:shadow-md transition-shadow' },
  h(CardContent, { className: 'flex items-center gap-4 p-4' }, [
    h(Avatar, { key: 'avatar', className: 'h-10 w-10', size: 'sm' },
      user.avatar
        ? h(AvatarImage, { src: user.avatar, alt: user.name })
        : h(AvatarFallback, {}, initials)
    ),
    h('div', { key: 'info', className: 'flex-1 min-w-0' }, [
      h('p', { key: 'name', className: 'font-medium truncate' }, user.name),
      h('p', { key: 'email', className: 'text-sm text-muted-foreground truncate' }, user.email),
    ]),
    h(Badge, { key: 'role', variant: 'outline' }, user.role),
  ])
)`

const CANVAS_TODOS = `var _t = useState([
  { id: 1, text: 'Buy groceries', done: false },
  { id: 2, text: 'Walk the dog', done: true },
])
var todos = _t[0], setTodos = _t[1]
var _i = useState('')
var input = _i[0], setInput = _i[1]

function addTodo() {
  if (!input.trim()) return
  setTodos(todos.concat([{ id: Date.now(), text: input, done: false }]))
  setInput('')
}

function toggleTodo(id) {
  setTodos(todos.map(function(t) {
    return t.id === id ? Object.assign({}, t, { done: !t.done }) : t
  }))
}

return h('div', { className: 'max-w-md mx-auto p-4' },
  h(Card, {}, [
    h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'My Tasks')),
    h(CardContent, { key: 'content', className: 'space-y-3' }, [
      h('div', { key: 'add-row', className: 'flex gap-2' }, [
        h(Input, {
          key: 'input',
          value: input,
          onChange: function(e) { setInput(e.target.value) },
          placeholder: 'Add a task...',
        }),
        h(Button, { key: 'btn', onClick: addTodo }, 'Add'),
      ]),
      todos.length === 0
        ? h('p', { key: 'empty', className: 'text-muted-foreground text-center py-4' }, 'No items')
        : h(Fragment, { key: 'list' },
            todos.map(function(todo) {
              return h('div', { key: todo.id, className: 'flex items-center gap-2' }, [
                h(Checkbox, {
                  key: 'check',
                  checked: todo.done,
                  onCheckedChange: function() { toggleTodo(todo.id) },
                }),
                h('span', {
                  key: 'text',
                  className: todo.done ? 'line-through text-muted-foreground' : '',
                }, todo.text),
              ])
            })
          ),
    ]),
  ])
)`

const CANVAS_LEADS = `var _d = useState([])
var leads = _d[0], setLeads = _d[1]
var _l = useState(true)
var loading = _l[0], setLoading = _l[1]

useEffect(function() {
  fetch('http://localhost:4100/api/leads')
    .then(function(r) { return r.json() })
    .then(function(data) { setLeads(data); setLoading(false) })
    .catch(function() { setLoading(false) })
}, [])

if (loading) return h('div', { className: 'p-4' }, h(Skeleton, { className: 'h-32 w-full' }))

return h('div', { className: 'flex flex-col gap-6 p-2' }, [
  h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Lead Tracker'),
  h(Card, { key: 'table' }, [
    h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'All Leads')),
    h(CardContent, { key: 'content' },
      h(Table, {}, [
        h(TableHeader, { key: 'thead' }, h(TableRow, {}, [
          h(TableHead, { key: 'name' }, 'Name'),
          h(TableHead, { key: 'email' }, 'Email'),
          h(TableHead, { key: 'status' }, 'Status'),
        ])),
        h(TableBody, { key: 'tbody' },
          leads.map(function(l) {
            return h(TableRow, { key: l.id }, [
              h(TableCell, { key: 'name' }, l.name),
              h(TableCell, { key: 'email' }, l.email),
              h(TableCell, { key: 'status' }, h(Badge, {}, l.status)),
            ])
          })
        ),
      ])
    ),
  ]),
  h(Button, { key: 'add', onClick: function() {} }, 'Add'),
])`

// ---------------------------------------------------------------------------
// Test Cases — All run against canvas v2 agent
// ---------------------------------------------------------------------------

export const EDIT_FILE_EVALS: AgentEval[] = [
  // =========================================================================
  // Level 1: Basic edit_file usage
  // =========================================================================
  {
    id: 'edit-file-simple-rename',
    name: 'Edit file: simple text rename',
    category: 'edit-file',
    level: 1,
    initialMode: 'canvas',
    input: 'Change the heading from "Welcome" to "Dashboard".',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/page.ts': CANVAS_PAGE,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on the canvas file',
        points: 25,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('page')
        ),
      },
      {
        id: 'read-first',
        description: 'Read the file before editing',
        points: 15,
        phase: 'intention',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'old-string-has-welcome',
        description: 'old_string references "Welcome"',
        points: 20,
        phase: 'execution',
        validate: (r) => editOldStringContains(r, 'Welcome'),
      },
      {
        id: 'new-string-has-dashboard',
        description: 'new_string contains "Dashboard"',
        points: 20,
        phase: 'execution',
        validate: (r) => editNewStringContains(r, 'Dashboard'),
      },
      {
        id: 'successful-edit',
        description: 'edit_file succeeded (no error)',
        points: 10,
        phase: 'execution',
        validate: (r) => usedToolSuccessfully(r, 'edit_file'),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=8)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  {
    id: 'edit-file-add-component',
    name: 'Edit file: add component to existing canvas',
    category: 'edit-file',
    level: 1,
    initialMode: 'canvas',
    input: 'Add a Badge showing "Active" next to the "Team Dashboard" title.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/team.ts': CANVAS_TEAM,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on the canvas file',
        points: 20,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('team')
        ),
      },
      {
        id: 'read-first',
        description: 'Read the file before editing',
        points: 15,
        phase: 'intention',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'added-badge',
        description: 'Added Badge component',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = allEditInputsJson(r)
          return json.includes('badge')
        },
      },
      {
        id: 'added-active-text',
        description: 'Badge shows "Active"',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'Active'),
      },
      {
        id: 'successful-edit',
        description: 'edit_file succeeded',
        points: 15,
        phase: 'execution',
        validate: (r) => usedToolSuccessfully(r, 'edit_file'),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=10)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  // =========================================================================
  // Level 2: Sequential edits + precision
  // =========================================================================
  {
    id: 'edit-file-sequential-same-file',
    name: 'Edit file: two sequential edits to same canvas file',
    category: 'edit-file',
    level: 2,
    initialMode: 'canvas',
    input: 'Rename the function "loadData" to "fetchItems" AND change the API endpoint from \'/api/data\' to \'/api/items\'.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/items.ts': CANVAS_ITEMS,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file (not write_file) on the canvas file',
        points: 20,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('items')
        ),
      },
      {
        id: 'no-write-file',
        description: 'Did NOT fall back to write_file',
        points: 15,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(t =>
          t.name === 'write_file' && String((t.input as any).path ?? '').includes('items')
        ),
      },
      {
        id: 'renamed-function',
        description: 'Changed loadData to fetchItems',
        points: 20,
        phase: 'execution',
        validate: (r) => editNewStringContains(r, 'fetchItems'),
      },
      {
        id: 'changed-endpoint',
        description: 'Changed /api/data to /api/items',
        points: 20,
        phase: 'execution',
        validate: (r) => editNewStringContains(r, '/api/items'),
      },
      {
        id: 'edits-succeeded',
        description: 'All edit_file calls succeeded',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const edits = r.toolCalls.filter(t => t.name === 'edit_file')
          return edits.length > 0 && edits.every(t => !t.error)
        },
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=12)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  {
    id: 'edit-file-three-changes',
    name: 'Edit file: three targeted changes to canvas config',
    category: 'edit-file',
    level: 2,
    initialMode: 'canvas',
    input: 'Update the settings: change appName from \'MyApp\' to \'Dashboard\', change version from \'1.0.0\' to \'2.0.0\', and change theme from \'light\' to \'dark\'.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/settings.ts': CANVAS_SETTINGS,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on the canvas file',
        points: 15,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('settings')
        ),
      },
      {
        id: 'no-write-file',
        description: 'Did NOT fall back to write_file',
        points: 10,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(t =>
          t.name === 'write_file' && String((t.input as any).path ?? '').includes('settings')
        ),
      },
      {
        id: 'changed-app-name',
        description: 'Changed MyApp to Dashboard',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'Dashboard'),
      },
      {
        id: 'changed-version',
        description: 'Changed 1.0.0 to 2.0.0',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, '2.0.0'),
      },
      {
        id: 'changed-theme',
        description: 'Changed light to dark',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, "'dark'"),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=12)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  {
    id: 'edit-file-repeated-patterns',
    name: 'Edit file: target correct input among repeated patterns',
    category: 'edit-file',
    level: 2,
    initialMode: 'canvas',
    input: 'Change the placeholder text for the email input from "Enter your email" to "you@company.com". Do NOT change the name or phone placeholders.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/form.ts': CANVAS_FORM,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on the canvas file',
        points: 15,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('form')
        ),
      },
      {
        id: 'read-first',
        description: 'Read the file first to understand the structure',
        points: 15,
        phase: 'intention',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'changed-email-placeholder',
        description: 'new_string contains the new email placeholder',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'you@company.com'),
      },
      {
        id: 'included-context',
        description: 'old_string includes enough context (email-related, not just placeholder text)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const emailEdits = r.toolCalls.filter(t => {
            if (t.name !== 'edit_file') return false
            const ns = String((t.input as any).new_string ?? '').toLowerCase()
            return ns.includes('you@company.com')
          })
          return emailEdits.some(t => {
            const os = String((t.input as any).old_string ?? '').toLowerCase()
            return os.includes('email')
          })
        },
      },
      {
        id: 'edit-succeeded',
        description: 'The edit_file call succeeded',
        points: 15,
        phase: 'execution',
        validate: (r) => usedToolSuccessfully(r, 'edit_file'),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=10)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  {
    id: 'edit-file-canvas-update',
    name: 'Edit file: update canvas dashboard metrics',
    category: 'edit-file',
    level: 2,
    initialMode: 'canvas',
    input: 'The dashboard shows 1,200 users but we hit 1,500 this morning. Update the Users metric and also add a new "Churn Rate" metric showing 2.4%.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/dashboard.ts': CANVAS_DASHBOARD,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on canvas/dashboard.ts',
        points: 20,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('dashboard')
        ),
      },
      {
        id: 'prefer-edit-over-write',
        description: 'Preferred edit_file (bonus: did not rewrite with write_file)',
        points: 10,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(t =>
          t.name === 'write_file' && String((t.input as any).path ?? '').includes('dashboard')
        ),
      },
      {
        id: 'updated-user-count',
        description: 'Changed user count from 1200 to 1500',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = allEditInputsJson(r)
          return json.includes('1500') || json.includes('1,500')
        },
      },
      {
        id: 'added-churn-metric',
        description: 'Added churn rate metric',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = allEditInputsJson(r)
          return json.includes('churn') && (json.includes('2.4') || json.includes('2.4%'))
        },
      },
      {
        id: 'edit-succeeded',
        description: 'At least one file modification succeeded',
        points: 10,
        phase: 'execution',
        validate: (r) => usedToolSuccessfully(r, 'edit_file') || usedToolSuccessfully(r, 'write_file'),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=12)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  // =========================================================================
  // Level 3: Anti-fallback + complex
  // =========================================================================
  {
    id: 'edit-file-large-file-targeted',
    name: 'Edit file: targeted change in large canvas file',
    category: 'edit-file',
    level: 3,
    initialMode: 'canvas',
    input: 'Change the MAX_RETRIES constant from 3 to 5.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/admin.ts': LARGE_CANVAS_ADMIN,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file (not write_file) on admin.js',
        points: 20,
        phase: 'intention',
        validate: (r) => usedEditNotWrite(r, /admin/),
      },
      {
        id: 'targeted-old-string',
        description: 'old_string is targeted (< 200 chars), not the whole file',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const edits = r.toolCalls.filter(t =>
            t.name === 'edit_file' && String((t.input as any).path ?? '').includes('admin')
          )
          return edits.some(t => String((t.input as any).old_string ?? '').length < 200)
        },
      },
      {
        id: 'changed-value',
        description: 'Changed MAX_RETRIES from 3 to 5',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const edits = r.toolCalls.filter(t => t.name === 'edit_file')
          return edits.some(t => {
            const os = String((t.input as any).old_string ?? '')
            const ns = String((t.input as any).new_string ?? '')
            return os.includes('3') && ns.includes('5') && (os.includes('MAX_RETRIES') || ns.includes('MAX_RETRIES'))
          })
        },
      },
      {
        id: 'edit-succeeded',
        description: 'edit_file succeeded',
        points: 15,
        phase: 'execution',
        validate: (r) => usedToolSuccessfully(r, 'edit_file'),
      },
      {
        id: 'read-first',
        description: 'Read file before editing',
        points: 15,
        phase: 'intention',
        validate: (r) => readBeforeFirstEdit(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=8)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  {
    id: 'edit-file-multi-change-no-rewrite',
    name: 'Edit file: 3 changes to canvas component, no rewrite',
    category: 'edit-file',
    level: 3,
    initialMode: 'canvas',
    input: 'Make three changes to the user card: change the avatar size from "sm" to "lg", change the role badge variant from "outline" to "secondary", and add an onClick handler to the Card that logs the user id.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/user-card.ts': CANVAS_USER_CARD,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on the canvas file',
        points: 15,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('user-card')
        ),
      },
      {
        id: 'no-write-file',
        description: 'Did NOT rewrite user-card.js with write_file',
        points: 15,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(t =>
          t.name === 'write_file' && String((t.input as any).path ?? '').includes('user-card')
        ),
      },
      {
        id: 'changed-avatar-size',
        description: 'Changed avatar size from sm to lg',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = allEditInputsJson(r)
          return json.includes("'lg'") || json.includes('"lg"')
        },
      },
      {
        id: 'changed-badge-variant',
        description: 'Changed badge variant from outline to secondary',
        points: 15,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'secondary'),
      },
      {
        id: 'added-onclick',
        description: 'Added onClick handler',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = allEditInputsJson(r)
          return json.includes('onclick') || json.includes('on_click') || json.includes('click')
        },
      },
      {
        id: 'all-edits-succeeded',
        description: 'All edit_file calls succeeded',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const edits = r.toolCalls.filter(t => t.name === 'edit_file')
          return edits.length > 0 && edits.every(t => !t.error)
        },
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=14)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 14,
      },
    ],
  },

  {
    id: 'edit-file-canvas-todos-sequential',
    name: 'Edit file: sequential edits to todo canvas',
    category: 'edit-file',
    level: 3,
    initialMode: 'canvas',
    input: 'Update the todo list: change the title from "My Tasks" to "Task Manager", add a subtitle saying "Stay organized" below the title, and change the empty state from "No items" to "All caught up!".',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/todos.ts': CANVAS_TODOS,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on canvas/todos.ts',
        points: 15,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('todos')
        ),
      },
      {
        id: 'no-write-file',
        description: 'Did NOT rewrite with write_file',
        points: 10,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(t =>
          t.name === 'write_file' && String((t.input as any).path ?? '').includes('todos')
        ),
      },
      {
        id: 'changed-title',
        description: 'Changed "My Tasks" to "Task Manager"',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'Task Manager'),
      },
      {
        id: 'added-subtitle',
        description: 'Added "Stay organized" subtitle',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'Stay organized'),
      },
      {
        id: 'changed-empty-state',
        description: 'Changed "No items" to "All caught up!"',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'caught up'),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=14)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 14,
      },
    ],
  },

  {
    id: 'edit-file-canvas-sequential',
    name: 'Edit file: sequential lead tracker edits',
    category: 'edit-file',
    level: 3,
    initialMode: 'canvas',
    input: 'Update the lead tracker: change the table header from "All Leads" to "Pipeline", add a "Last Contact" column header to the table, and change the "Add" button text to "New Lead".',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/leads.ts': CANVAS_LEADS,
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on canvas/leads.ts',
        points: 15,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'edit_file' && String((t.input as any).path ?? '').includes('leads')
        ),
      },
      {
        id: 'prefer-edit-over-write',
        description: 'Preferred edit_file (bonus: did not rewrite with write_file)',
        points: 10,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(t =>
          t.name === 'write_file' && String((t.input as any).path ?? '').includes('leads')
        ),
      },
      {
        id: 'changed-header',
        description: 'Changed "All Leads" to "Pipeline"',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'Pipeline'),
      },
      {
        id: 'added-column',
        description: 'Added "Last Contact" column',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = allEditInputsJson(r)
          return json.includes('last contact') || json.includes('lastcontact')
        },
      },
      {
        id: 'changed-button',
        description: 'Changed "Add" button to "New Lead"',
        points: 20,
        phase: 'execution',
        validate: (r) => anyFileOutputContains(r, 'New Lead'),
      },
      {
        id: 'reasonable-tools',
        description: 'Reasonable tool count (<=14)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 14,
      },
    ],
  },
]
