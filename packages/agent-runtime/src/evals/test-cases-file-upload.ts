/**
 * File Upload RAG Eval Test Cases
 *
 * Tests the agent's ability to discover and use files uploaded to the
 * workspace `files/` directory. The system prompt dynamically lists
 * uploaded files and the agent should use `list_files`, `search_files`,
 * and `read_file` to interact with them.
 */

import type { AgentEval } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  usedTool,
  responseContains,
  toolCallArgsContain,
  neverUsedTool,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Tool mock fixtures
// ---------------------------------------------------------------------------

const CSV_CONTENT = `Date,Product,Revenue,Units
2026-01-15,Widget A,12500,250
2026-01-15,Widget B,8400,120
2026-01-15,Gadget X,21000,70
2026-02-01,Widget A,13200,264
2026-02-01,Widget B,7900,113
2026-02-01,Gadget X,23500,78
2026-02-15,Widget A,14100,282
2026-02-15,Widget B,9200,131
2026-02-15,Gadget X,25000,83`

const MARKDOWN_NOTES = `# Project Alpha — Meeting Notes

## Feb 18, 2026

### Attendees
- Sarah Chen (PM)
- Mike Torres (Eng Lead)
- Lisa Park (Design)

### Key Decisions
1. Launch date moved to March 15
2. MVP will include: auth, dashboard, and API v1
3. Budget approved for 2 additional contractors

### Action Items
- [ ] Mike: Set up CI/CD pipeline by Feb 25
- [ ] Lisa: Finalize design system tokens by Feb 22
- [ ] Sarah: Send stakeholder update by EOD Friday

## Feb 11, 2026

### Attendees
- Sarah Chen (PM)
- Mike Torres (Eng Lead)

### Key Decisions
1. Chose PostgreSQL over MongoDB for primary datastore
2. Will use Hono for the API framework
3. Auth will use Better Auth library`

const JSON_CONFIG = JSON.stringify({
  database: {
    host: 'db.internal.acme.com',
    port: 5432,
    name: 'acme_prod',
    pool_size: 20,
    ssl: true,
  },
  redis: {
    host: 'redis.internal.acme.com',
    port: 6379,
    cluster: true,
  },
  features: {
    dark_mode: true,
    beta_api: false,
    new_dashboard: true,
    ai_assistant: true,
  },
}, null, 2)

const PLAIN_TEXT_LOG = `[2026-02-20 14:32:01] ERROR auth-service: SAML assertion expired for user admin@enterprise.co
[2026-02-20 14:32:05] WARN  session-store: Redis connection timeout (3.2s)
[2026-02-20 14:32:08] ERROR auth-service: Failed to refresh session token — redis unavailable
[2026-02-20 14:33:12] INFO  deploy-bot: Deployment v2.4.1 completed (sha: a1b2c3d)
[2026-02-20 14:33:15] ERROR auth-service: TypeError: Cannot read property "session" of null at authMiddleware.ts:42
[2026-02-20 14:33:18] ERROR api-gateway: HTTP 500 on /api/v2/users/me — upstream auth failure
[2026-02-20 14:34:00] WARN  monitor: Error rate spike detected: 0.1% → 15.1%
[2026-02-20 14:35:22] INFO  oncall-bot: Paging @mike-torres for P1 incident`

// ---------------------------------------------------------------------------
// Mock: Single CSV file in workspace
// ---------------------------------------------------------------------------

const FILE_UPLOAD_SINGLE_CSV_MOCKS: ToolMockMap = {
  list_files: {
    type: 'static',
    description: 'List files in the workspace files/ directory.',
    paramKeys: ['path'],
    response: {
      files: [
        { name: 'sales-report.csv', size: 312, modified: '2026-02-25T10:00:00Z' },
      ],
      total: 1,
    },
  },
  read_file: {
    type: 'pattern',
    description: 'Read a file from the workspace.',
    paramKeys: ['path'],
    patterns: [
      {
        match: { path: 'sales-report' },
        response: { content: CSV_CONTENT, path: 'files/sales-report.csv', size: 312 },
      },
      {
        match: { path: 'sales' },
        response: { content: CSV_CONTENT, path: 'files/sales-report.csv', size: 312 },
      },
    ],
    default: { error: 'File not found' },
  },
  search_files: {
    type: 'pattern',
    description: 'RAG search across indexed files.',
    paramKeys: ['query'],
    patterns: [
      {
        match: { query: 'revenue' },
        response: {
          results: [
            { file: 'files/sales-report.csv', score: 0.92, snippet: 'Widget A,12500,250\nWidget A,13200,264\nWidget A,14100,282' },
          ],
        },
      },
      {
        match: { query: 'gadget' },
        response: {
          results: [
            { file: 'files/sales-report.csv', score: 0.95, snippet: 'Gadget X,21000,70\nGadget X,23500,78\nGadget X,25000,83' },
          ],
        },
      },
    ],
    default: {
      results: [
        { file: 'files/sales-report.csv', score: 0.8, snippet: CSV_CONTENT.slice(0, 200) },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Mock: Multiple files in workspace
// ---------------------------------------------------------------------------

const FILE_UPLOAD_MULTI_MOCKS: ToolMockMap = {
  list_files: {
    type: 'static',
    description: 'List files in the workspace files/ directory.',
    paramKeys: ['path'],
    response: {
      files: [
        { name: 'sales-report.csv', size: 312, modified: '2026-02-25T10:00:00Z' },
        { name: 'meeting-notes.md', size: 890, modified: '2026-02-25T09:30:00Z' },
        { name: 'config.json', size: 245, modified: '2026-02-24T14:00:00Z' },
        { name: 'deploy.log', size: 567, modified: '2026-02-25T11:00:00Z' },
      ],
      total: 4,
    },
  },
  read_file: {
    type: 'pattern',
    description: 'Read a file from the workspace.',
    paramKeys: ['path'],
    patterns: [
      {
        match: { path: 'sales' },
        response: { content: CSV_CONTENT, path: 'files/sales-report.csv', size: 312 },
      },
      {
        match: { path: 'meeting' },
        response: { content: MARKDOWN_NOTES, path: 'files/meeting-notes.md', size: 890 },
      },
      {
        match: { path: 'config' },
        response: { content: JSON_CONFIG, path: 'files/config.json', size: 245 },
      },
      {
        match: { path: 'deploy' },
        response: { content: PLAIN_TEXT_LOG, path: 'files/deploy.log', size: 567 },
      },
    ],
    default: { error: 'File not found' },
  },
  search_files: {
    type: 'pattern',
    description: 'RAG search across indexed files.',
    paramKeys: ['query'],
    patterns: [
      {
        match: { query: 'launch' },
        response: {
          results: [
            { file: 'files/meeting-notes.md', score: 0.94, snippet: 'Launch date moved to March 15\nMVP will include: auth, dashboard, and API v1' },
          ],
        },
      },
      {
        match: { query: 'error' },
        response: {
          results: [
            { file: 'files/deploy.log', score: 0.96, snippet: '[2026-02-20 14:32:01] ERROR auth-service: SAML assertion expired\n[2026-02-20 14:33:15] ERROR auth-service: TypeError: Cannot read property "session" of null' },
          ],
        },
      },
      {
        match: { query: 'database' },
        response: {
          results: [
            { file: 'files/config.json', score: 0.91, snippet: '"database": { "host": "db.internal.acme.com", "port": 5432' },
            { file: 'files/meeting-notes.md', score: 0.78, snippet: 'Chose PostgreSQL over MongoDB for primary datastore' },
          ],
        },
      },
      {
        match: { query: 'revenue' },
        response: {
          results: [
            { file: 'files/sales-report.csv', score: 0.92, snippet: 'Widget A,12500,250\nWidget A,13200,264\nWidget A,14100,282' },
          ],
        },
      },
    ],
    default: {
      results: [],
    },
  },
}

// ---------------------------------------------------------------------------
// Eval cases
// ---------------------------------------------------------------------------

export const FILE_UPLOAD_EVALS: AgentEval[] = [
  // --- Level 1: Basic file discovery ---
  {
    id: 'file-upload-list-files',
    name: 'File Upload: List uploaded files when asked',
    category: 'tool-usage',
    level: 1,
    input: 'What files have I uploaded?',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_MULTI_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
      'files/meeting-notes.md': MARKDOWN_NOTES,
      'files/config.json': JSON_CONFIG,
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'used-list-files',
        description: 'Used list_files to check the files/ directory',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'list_files'),
      },
      {
        id: 'mentions-csv',
        description: 'Response mentions the sales CSV file',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'sales'),
      },
      {
        id: 'mentions-notes',
        description: 'Response mentions the meeting notes file',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'meeting'),
      },
      {
        id: 'mentions-config',
        description: 'Response mentions the config file',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'config'),
      },
      {
        id: 'mentions-log',
        description: 'Response mentions the deploy log file',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'deploy'),
      },
    ],
  },

  // --- Level 1: Read a specific file ---
  {
    id: 'file-upload-read-csv',
    name: 'File Upload: Read and summarize a CSV file',
    category: 'tool-usage',
    level: 1,
    input: 'Can you read my sales report CSV and tell me the total revenue for Gadget X?',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_SINGLE_CSV_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
    },
    validationCriteria: [
      {
        id: 'used-read-file',
        description: 'Used read_file to read the CSV',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file'),
      },
      {
        id: 'read-correct-file',
        description: 'Read the sales-report.csv file specifically',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'read_file', 'sales'),
      },
      {
        id: 'mentions-gadget-x',
        description: 'Response mentions Gadget X',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'gadget'),
      },
      {
        id: 'calculates-total',
        description: 'Response includes a revenue figure (69500 or close)',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('69,500') || text.includes('69500') || text.includes('$69')
        },
      },
    ],
  },

  // --- Level 2: Search files for specific content ---
  {
    id: 'file-upload-search-content',
    name: 'File Upload: Search uploaded files for specific information',
    category: 'tool-usage',
    level: 2,
    input: 'Search my uploaded files for any errors that happened recently.',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_MULTI_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
      'files/meeting-notes.md': MARKDOWN_NOTES,
      'files/config.json': JSON_CONFIG,
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'used-search-or-read',
        description: 'Used search_files or read_file to find error info',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'search_files') || usedTool(r, 'read_file'),
      },
      {
        id: 'found-deploy-log',
        description: 'Identified or read the deploy log containing errors',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('deploy') || json.includes('error')
        },
      },
      {
        id: 'mentions-saml-or-auth-error',
        description: 'Response mentions the SAML/auth errors from the log',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('saml') || text.includes('auth') || text.includes('session')
        },
      },
      {
        id: 'mentions-error-rate',
        description: 'Response mentions error rate spike or specific error details',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('error rate') || text.includes('15.1') || text.includes('typeerror') || text.includes('redis')
        },
      },
    ],
  },

  // --- Level 2: Ask about a specific file by name ---
  {
    id: 'file-upload-read-meeting-notes',
    name: 'File Upload: Read meeting notes and extract action items',
    category: 'tool-usage',
    level: 2,
    input: 'What are the action items from my meeting notes?',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_MULTI_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
      'files/meeting-notes.md': MARKDOWN_NOTES,
      'files/config.json': JSON_CONFIG,
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'used-file-tool',
        description: 'Used read_file or search_files to access meeting notes',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search_files'),
      },
      {
        id: 'read-meeting-file',
        description: 'Targeted the meeting-notes.md file',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('meeting')
        },
      },
      {
        id: 'mentions-mike-cicd',
        description: 'Mentions Mike\'s CI/CD pipeline action item',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'mike') || responseContains(r, 'ci/cd', 'pipeline'),
      },
      {
        id: 'mentions-lisa-design',
        description: 'Mentions Lisa\'s design system action item',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'lisa') || responseContains(r, 'design'),
      },
      {
        id: 'mentions-sarah-update',
        description: 'Mentions Sarah\'s stakeholder update action item',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'sarah') || responseContains(r, 'stakeholder'),
      },
    ],
  },

  // --- Level 2: Cross-file query ---
  {
    id: 'file-upload-cross-file-search',
    name: 'File Upload: Cross-file search for database information',
    category: 'tool-usage',
    level: 2,
    input: 'What database are we using? Check my uploaded files for any database-related info.',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_MULTI_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
      'files/meeting-notes.md': MARKDOWN_NOTES,
      'files/config.json': JSON_CONFIG,
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'used-search-or-read',
        description: 'Used search_files or read_file for database info',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'search_files') || usedTool(r, 'read_file'),
      },
      {
        id: 'mentions-postgresql',
        description: 'Found PostgreSQL mention from meeting notes or config',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('postgres')
        },
      },
      {
        id: 'mentions-host-or-config',
        description: 'Mentions the database host or config details',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('acme') || text.includes('5432') || text.includes('config')
        },
      },
      {
        id: 'mentions-meeting-decision',
        description: 'References the team decision to use PostgreSQL over MongoDB',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('mongodb') || text.includes('chose') || text.includes('decision') || text.includes('meeting')
        },
      },
    ],
  },

  // --- Level 3: Implicit reference to uploaded data ---
  {
    id: 'file-upload-implicit-reference',
    name: 'File Upload: Implicit reference — "my data" without naming the file',
    category: 'tool-usage',
    level: 3,
    input: 'Which product had the highest revenue growth in my data?',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_SINGLE_CSV_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
    },
    validationCriteria: [
      {
        id: 'discovered-files',
        description: 'Used list_files or search_files to discover available data',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'list_files') || usedTool(r, 'search_files') || usedTool(r, 'read_file'),
      },
      {
        id: 'read-the-data',
        description: 'Used read_file to access the CSV data',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file'),
      },
      {
        id: 'mentions-products',
        description: 'Response discusses the actual products from the data',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('widget') || text.includes('gadget'))
        },
      },
      {
        id: 'identifies-growth-leader',
        description: 'Identifies a product with notable revenue growth',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('growth') || text.includes('increase') || text.includes('highest')
        },
      },
      {
        id: 'does-not-hallucinate',
        description: 'Does not invent products not in the data',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const hasRealProducts = text.includes('widget') || text.includes('gadget')
          const noFakeProducts = !text.includes('product c') && !text.includes('product d')
          return hasRealProducts && noFakeProducts
        },
      },
    ],
    antiPatterns: [
      'Agent responds with made-up data without reading the file',
      'Agent claims there are no files when files exist',
    ],
  },

  // --- Level 3: Multi-turn — ask about uploaded files from prior context ---
  {
    id: 'file-upload-multiturn-followup',
    name: 'File Upload: Multi-turn follow-up about uploaded file',
    category: 'tool-usage',
    level: 3,
    conversationHistory: [
      { role: 'user', content: 'I just uploaded a deploy log to the files directory.' },
      { role: 'assistant', content: 'I can see you\'ve uploaded a deploy log. Would you like me to analyze it for any issues?' },
    ],
    input: 'Yes, what went wrong in the deployment?',
    maxScore: 100,
    toolMocks: {
      list_files: {
        type: 'static',
        paramKeys: ['path'],
        response: {
          files: [{ name: 'deploy.log', size: 567, modified: '2026-02-25T11:00:00Z' }],
          total: 1,
        },
      },
      read_file: {
        type: 'static',
        paramKeys: ['path'],
        response: { content: PLAIN_TEXT_LOG, path: 'files/deploy.log', size: 567 },
      },
      search_files: {
        type: 'static',
        paramKeys: ['query'],
        response: {
          results: [
            { file: 'files/deploy.log', score: 0.96, snippet: PLAIN_TEXT_LOG.slice(0, 300) },
          ],
        },
      },
    },
    workspaceFiles: {
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'used-file-tools',
        description: 'Used read_file or search_files to access the deploy log',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search_files'),
      },
      {
        id: 'identifies-root-cause',
        description: 'Identifies the auth/session errors as key issues',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('auth') || text.includes('session') || text.includes('saml')
        },
      },
      {
        id: 'mentions-redis-issue',
        description: 'Mentions the Redis connection timeout',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'redis'),
      },
      {
        id: 'mentions-error-spike',
        description: 'Mentions the error rate spike or deployment correlation',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('spike') || text.includes('15.1') || text.includes('deployment') || text.includes('v2.4.1')
        },
      },
    ],
  },

  // --- Level 2: JSON config inspection ---
  {
    id: 'file-upload-read-json-config',
    name: 'File Upload: Read JSON config and report feature flags',
    category: 'tool-usage',
    level: 2,
    input: 'What feature flags are currently enabled in our config?',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_MULTI_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
      'files/meeting-notes.md': MARKDOWN_NOTES,
      'files/config.json': JSON_CONFIG,
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'used-file-tools',
        description: 'Used read_file or search_files to check config',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search_files'),
      },
      {
        id: 'targeted-config',
        description: 'Read or searched the config.json file',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('config')
        },
      },
      {
        id: 'mentions-dark-mode',
        description: 'Correctly identifies dark_mode as enabled',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'dark mode') || responseContains(r, 'dark_mode'),
      },
      {
        id: 'mentions-new-dashboard',
        description: 'Correctly identifies new_dashboard as enabled',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'dashboard') || responseContains(r, 'new_dashboard'),
      },
      {
        id: 'mentions-beta-api-disabled',
        description: 'Correctly notes beta_api is disabled',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('beta') && (text.includes('disabled') || text.includes('false') || text.includes('off'))
        },
      },
    ],
  },

  // --- Level 1: No files uploaded — agent should not hallucinate ---
  {
    id: 'file-upload-no-files',
    name: 'File Upload: Gracefully handle when no files are uploaded',
    category: 'tool-usage',
    level: 1,
    input: 'Can you check my uploaded files for budget data?',
    maxScore: 100,
    toolMocks: {
      list_files: {
        type: 'static',
        paramKeys: ['path'],
        response: { files: [], total: 0 },
      },
      search_files: {
        type: 'static',
        paramKeys: ['query'],
        response: { results: [] },
      },
      read_file: {
        type: 'static',
        paramKeys: ['path'],
        response: { error: 'File not found' },
      },
    },
    validationCriteria: [
      {
        id: 'checked-files',
        description: 'Attempted to check files via list_files or search_files',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'list_files') || usedTool(r, 'search_files'),
      },
      {
        id: 'reports-no-files',
        description: 'Informs user that no files/budget data was found',
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('no file') || text.includes('no budget') ||
            text.includes('couldn\'t find') || text.includes('not find') ||
            text.includes('don\'t see') || text.includes('empty') ||
            text.includes('haven\'t uploaded') || text.includes('no uploaded')
        },
      },
      {
        id: 'does-not-hallucinate-data',
        description: 'Does not make up budget numbers',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return !text.includes('$') || text.includes('no') || text.includes('upload')
        },
      },
    ],
    antiPatterns: [
      'Agent invents budget figures when no files exist',
      'Agent claims to have found data that does not exist',
    ],
  },

  // --- Level 3: Complex analysis across multiple files ---
  {
    id: 'file-upload-incident-analysis',
    name: 'File Upload: Incident analysis using log + config + notes',
    category: 'tool-usage',
    level: 3,
    input: 'We had a production incident. Check my uploaded files — the deploy log, config, and meeting notes — and give me a summary of what happened and what the team should focus on.',
    maxScore: 100,
    toolMocks: FILE_UPLOAD_MULTI_MOCKS,
    workspaceFiles: {
      'files/sales-report.csv': CSV_CONTENT,
      'files/meeting-notes.md': MARKDOWN_NOTES,
      'files/config.json': JSON_CONFIG,
      'files/deploy.log': PLAIN_TEXT_LOG,
    },
    validationCriteria: [
      {
        id: 'read-multiple-files',
        description: 'Read at least 2 different files',
        points: 20,
        phase: 'intention',
        validate: (r) => {
          const readCalls = r.toolCalls.filter(t => t.name === 'read_file' || t.name === 'search_files')
          return readCalls.length >= 2
        },
      },
      {
        id: 'read-deploy-log',
        description: 'Read the deploy log for error details',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('deploy')
        },
      },
      {
        id: 'identifies-errors',
        description: 'Identifies key errors from the deploy log',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('auth') || text.includes('session') || text.includes('saml')) &&
            (text.includes('redis') || text.includes('timeout') || text.includes('error'))
        },
      },
      {
        id: 'provides-recommendations',
        description: 'Provides actionable recommendations or next steps',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('recommend') || text.includes('should') || text.includes('focus') ||
            text.includes('next step') || text.includes('action') || text.includes('suggest')
        },
      },
      {
        id: 'correlates-deployment',
        description: 'Correlates the errors with the deployment event',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('deploy') && (text.includes('v2.4.1') || text.includes('a1b2c3d') || text.includes('after'))
        },
      },
    ],
    antiPatterns: [
      'Agent analyzes only one file when multiple were requested',
      'Agent fails to connect the deployment to the errors',
    ],
  },

  // --- Level 2: When the user says "the file I uploaded" (singular, ambiguous) ---
  {
    id: 'file-upload-ambiguous-reference',
    name: 'File Upload: Resolve ambiguous "the file" reference',
    category: 'tool-usage',
    level: 2,
    input: 'Summarize the file I uploaded.',
    maxScore: 100,
    toolMocks: {
      list_files: {
        type: 'static',
        paramKeys: ['path'],
        response: {
          files: [
            { name: 'quarterly-report.csv', size: 312, modified: '2026-02-25T10:00:00Z' },
          ],
          total: 1,
        },
      },
      read_file: {
        type: 'static',
        paramKeys: ['path'],
        response: { content: CSV_CONTENT, path: 'files/quarterly-report.csv', size: 312 },
      },
      search_files: {
        type: 'static',
        paramKeys: ['query'],
        response: {
          results: [
            { file: 'files/quarterly-report.csv', score: 0.8, snippet: CSV_CONTENT.slice(0, 200) },
          ],
        },
      },
    },
    workspaceFiles: {
      'files/quarterly-report.csv': CSV_CONTENT,
    },
    validationCriteria: [
      {
        id: 'discovers-file',
        description: 'Used list_files to discover which file was uploaded',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'list_files'),
      },
      {
        id: 'reads-file',
        description: 'Read the discovered file',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file'),
      },
      {
        id: 'summarizes-content',
        description: 'Provides a summary of the actual CSV content',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('widget') || text.includes('gadget') || text.includes('revenue') || text.includes('product'))
        },
      },
      {
        id: 'no-hallucination',
        description: 'Does not make up file content',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'web'),
      },
    ],
  },
]
