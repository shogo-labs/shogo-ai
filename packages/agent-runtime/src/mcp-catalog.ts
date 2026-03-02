/**
 * MCP Server Catalog
 *
 * Curated registry of prepackaged MCP servers that can be toggled on/off
 * per agent. Each entry describes the server, what tools it provides,
 * the install command, and any required environment variables.
 */

export type MCPAuthType = 'composio' | 'api_key' | 'none'

export interface MCPCatalogEntry {
  /** Unique slug used as the key in config.json mcpServers */
  id: string
  name: string
  description: string
  category: MCPCategory
  /** npm package to run via npx */
  package: string
  /** Default args passed after the package name */
  defaultArgs: string[]
  /** Environment variables the server requires (key -> description) */
  requiredEnv: Record<string, string>
  /** Optional environment variables */
  optionalEnv?: Record<string, string>
  /** Human-readable list of tools this server provides */
  providedTools: string[]
  /** Icon emoji for the UI */
  icon: string
  /** Whether this server works in cloud sandboxes (some need local access) */
  cloudCompatible: boolean
  /** Whether this package is pre-installed in the Docker image for instant startup */
  preinstalled?: boolean
  /** Auth type: 'composio' for managed OAuth, 'api_key' for user-provided keys, 'none' for no auth */
  authType?: MCPAuthType
  /** Composio toolkit slug (e.g. 'google_calendar', 'gmail') — only used when authType is 'composio' */
  composioToolkit?: string
}

export type MCPCategory =
  | 'browse'
  | 'code'
  | 'data'
  | 'communication'
  | 'productivity'
  | 'finance'
  | 'search'
  | 'monitoring'
  | 'files'
  | 'travel'

export const MCP_CATEGORIES: Record<MCPCategory, { label: string; icon: string }> = {
  browse: { label: 'Browse & Scrape', icon: '🌐' },
  code: { label: 'Code & Dev', icon: '💻' },
  data: { label: 'Data & Databases', icon: '🗄️' },
  communication: { label: 'Communication', icon: '💬' },
  productivity: { label: 'Productivity', icon: '📋' },
  finance: { label: 'Finance', icon: '💳' },
  search: { label: 'AI & Search', icon: '🔍' },
  monitoring: { label: 'Monitoring', icon: '📊' },
  files: { label: 'Files & Storage', icon: '📁' },
  travel: { label: 'Travel & Booking', icon: '✈️' },
}

export const MCP_CATALOG: MCPCatalogEntry[] = [
  {
    id: 'playwright',
    name: 'Playwright Browser',
    description: 'Full browser automation — navigate pages, click elements, fill forms, take screenshots, and scrape dynamic content.',
    category: 'browse',
    package: '@playwright/mcp@latest',
    defaultArgs: [],
    requiredEnv: {},
    providedTools: ['browser_navigate', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_evaluate'],
    icon: '🎭',
    cloudCompatible: true,
    preinstalled: true,
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    description: 'Clean web page fetching with automatic readability extraction. Returns markdown content from any URL.',
    category: 'browse',
    package: 'mcp-fetch-node@latest',
    defaultArgs: [],
    requiredEnv: {},
    providedTools: ['fetch'],
    icon: '📄',
    cloudCompatible: true,
    preinstalled: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Full GitHub integration — manage issues, pull requests, repositories, code search, and actions.',
    category: 'code',
    package: '@modelcontextprotocol/server-github@latest',
    defaultArgs: [],
    requiredEnv: {
      GITHUB_TOKEN: 'GitHub personal access token (Settings > Developer settings > Personal access tokens)',
    },
    providedTools: ['github_create_issue', 'github_list_issues', 'github_create_pr', 'github_search_code', 'github_get_file'],
    icon: '🐙',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'github',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'GitLab project management — issues, merge requests, pipelines, and repository operations.',
    category: 'code',
    package: '@modelcontextprotocol/server-gitlab@latest',
    defaultArgs: [],
    requiredEnv: {
      GITLAB_TOKEN: 'GitLab personal access token',
      GITLAB_URL: 'GitLab instance URL (e.g. https://gitlab.com)',
    },
    providedTools: ['gitlab_create_issue', 'gitlab_list_mrs', 'gitlab_get_pipeline', 'gitlab_search'],
    icon: '🦊',
    cloudCompatible: true,
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Linear issue tracking — create and manage issues, projects, and cycles.',
    category: 'code',
    package: 'mcp-server-linear@latest',
    defaultArgs: [],
    requiredEnv: {
      LINEAR_API_KEY: 'Linear API key (Settings > API > Personal API keys)',
    },
    providedTools: ['linear_create_issue', 'linear_list_issues', 'linear_update_issue', 'linear_search'],
    icon: '📐',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'linear',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query PostgreSQL databases — run SQL queries, list tables, describe schemas.',
    category: 'data',
    package: '@modelcontextprotocol/server-postgres@latest',
    defaultArgs: [],
    requiredEnv: {
      POSTGRES_CONNECTION_STRING: 'PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/db)',
    },
    providedTools: ['postgres_query', 'postgres_list_tables', 'postgres_describe_table'],
    icon: '🐘',
    cloudCompatible: true,
    preinstalled: true,
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Local SQLite database operations — create databases, run queries, manage schemas.',
    category: 'data',
    package: 'mcp-server-sqlite@latest',
    defaultArgs: [],
    requiredEnv: {},
    optionalEnv: {
      SQLITE_DB_PATH: 'Path to SQLite database file (default: creates in workspace)',
    },
    providedTools: ['sqlite_query', 'sqlite_execute', 'sqlite_list_tables', 'sqlite_describe_table'],
    icon: '💾',
    cloudCompatible: true,
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'Query and manage MongoDB databases — run queries, list collections, aggregate data, and manage indexes.',
    category: 'data',
    package: 'mongodb-mcp-server@latest',
    defaultArgs: [],
    requiredEnv: {
      MDB_MCP_CONNECTION_STRING: 'MongoDB connection string (e.g. mongodb+srv://user:pass@cluster.mongodb.net/db)',
    },
    providedTools: ['mongodb_find', 'mongodb_aggregate', 'mongodb_list_collections', 'mongodb_insert', 'mongodb_update', 'mongodb_delete'],
    icon: '🍃',
    cloudCompatible: true,
    preinstalled: true,
  },
  {
    id: 'discourse',
    name: 'Discourse',
    description: 'Interact with Discourse forums — search topics, read posts, list categories, tags, and users.',
    category: 'communication',
    package: '@discourse/mcp@latest',
    defaultArgs: [],
    requiredEnv: {},
    optionalEnv: {
      DISCOURSE_SITE: 'Discourse site URL (e.g. https://forum.example.com)',
    },
    providedTools: ['discourse_search', 'discourse_read_topic', 'discourse_read_post', 'discourse_get_user', 'discourse_filter_topics', 'discourse_select_site'],
    icon: '💬',
    cloudCompatible: true,
    preinstalled: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and send Slack messages, manage channels, search conversation history.',
    category: 'communication',
    package: '@modelcontextprotocol/server-slack@latest',
    defaultArgs: [],
    requiredEnv: {
      SLACK_BOT_TOKEN: 'Slack Bot User OAuth Token (xoxb-...)',
    },
    providedTools: ['slack_send_message', 'slack_list_channels', 'slack_read_messages', 'slack_search'],
    icon: '💼',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'slack',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read, send, and search emails via Gmail API. Manage labels and drafts.',
    category: 'communication',
    package: 'gmail-mcp@latest',
    defaultArgs: [],
    requiredEnv: {
      GMAIL_CREDENTIALS: 'Gmail OAuth credentials JSON',
    },
    providedTools: ['gmail_send', 'gmail_search', 'gmail_read', 'gmail_list_labels'],
    icon: '📧',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'gmail',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Browse, read, and search Google Drive files. Access documents, spreadsheets, and presentations.',
    category: 'productivity',
    package: 'google-drive-mcp@latest',
    defaultArgs: [],
    requiredEnv: {
      GOOGLE_DRIVE_CREDENTIALS: 'Google OAuth credentials JSON',
    },
    providedTools: ['drive_list_files', 'drive_read_file', 'drive_search', 'drive_create_file'],
    icon: '📁',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'googledrive',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Manage calendar events — create, update, list, and search events across calendars.',
    category: 'productivity',
    package: 'google-calendar-mcp@latest',
    defaultArgs: [],
    requiredEnv: {
      GOOGLE_CALENDAR_CREDENTIALS: 'Google OAuth credentials JSON',
    },
    providedTools: ['calendar_list_events', 'calendar_create_event', 'calendar_update_event', 'calendar_search'],
    icon: '📅',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'googlecalendar',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Access Notion workspace — read and create pages, query databases, search content.',
    category: 'productivity',
    package: '@notionhq/notion-mcp-server@latest',
    defaultArgs: [],
    requiredEnv: {
      NOTION_API_KEY: 'Notion integration token (Settings > Integrations)',
    },
    providedTools: ['notion_search', 'notion_read_page', 'notion_create_page', 'notion_query_database'],
    icon: '📝',
    cloudCompatible: true,
    authType: 'composio',
    composioToolkit: 'notion',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Manage Stripe payments — customers, invoices, subscriptions, and payment intents.',
    category: 'finance',
    package: 'mcp-server-stripe@latest',
    defaultArgs: [],
    requiredEnv: {
      STRIPE_SECRET_KEY: 'Stripe secret API key (sk_...)',
    },
    providedTools: ['stripe_list_customers', 'stripe_create_invoice', 'stripe_get_balance', 'stripe_list_payments'],
    icon: '💳',
    cloudCompatible: true,
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search via Brave Search API — fast, private search results with snippets.',
    category: 'search',
    package: '@modelcontextprotocol/server-brave-search@latest',
    defaultArgs: [],
    requiredEnv: {
      BRAVE_API_KEY: 'Brave Search API key (brave.com/search/api)',
    },
    providedTools: ['brave_web_search', 'brave_local_search'],
    icon: '🦁',
    cloudCompatible: true,
  },
  {
    id: 'exa',
    name: 'Exa Search',
    description: 'Semantic web search powered by Exa — find content by meaning, not just keywords.',
    category: 'search',
    package: 'exa-mcp-server@latest',
    defaultArgs: [],
    requiredEnv: {
      EXA_API_KEY: 'Exa API key (exa.ai)',
    },
    providedTools: ['exa_search', 'exa_find_similar', 'exa_get_contents'],
    icon: '🔮',
    cloudCompatible: true,
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Monitor application errors — list issues, get event details, manage alerts.',
    category: 'monitoring',
    package: '@sentry/mcp-server@latest',
    defaultArgs: [],
    requiredEnv: {
      SENTRY_AUTH_TOKEN: 'Sentry authentication token',
      SENTRY_ORG: 'Sentry organization slug',
    },
    providedTools: ['sentry_list_issues', 'sentry_get_issue', 'sentry_list_projects', 'sentry_search_events'],
    icon: '🔴',
    cloudCompatible: true,
  },
  {
    id: 'airbnb',
    name: 'Airbnb',
    description: 'Search Airbnb listings by location, dates, guests, and price range. Get detailed property info including amenities, photos, and policies.',
    category: 'travel',
    package: '@openbnb/mcp-server-airbnb@latest',
    defaultArgs: ['--ignore-robots-txt'],
    requiredEnv: {},
    providedTools: ['airbnb_search', 'airbnb_listing_details'],
    icon: '🏠',
    cloudCompatible: true,
    preinstalled: true,
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on the host system. Useful for agents that manage local documents or configs.',
    category: 'files',
    package: '@modelcontextprotocol/server-filesystem@latest',
    defaultArgs: [],
    requiredEnv: {},
    optionalEnv: {
      ALLOWED_DIRECTORIES: 'Comma-separated list of allowed directory paths',
    },
    providedTools: ['fs_read_file', 'fs_write_file', 'fs_list_directory', 'fs_search_files'],
    icon: '📂',
    cloudCompatible: false,
    preinstalled: true,
  },
]

/** Look up a catalog entry by ID */
export function getCatalogEntry(id: string): MCPCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id)
}

/** Get all catalog entries marked for pre-installation */
export function getPreinstalledPackages(): MCPCatalogEntry[] {
  return MCP_CATALOG.filter((e) => e.preinstalled)
}

/** Check if a server ID is in the preinstalled whitelist */
export function isPreinstalledMcpId(id: string): boolean {
  return MCP_CATALOG.some((e) => e.id === id && e.preinstalled === true)
}

/** Get the preinstalled catalog entry for a server ID, or undefined if not whitelisted */
export function getPreinstalledEntry(id: string): MCPCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id && e.preinstalled === true)
}

/** Get catalog entries filtered by category */
export function getCatalogByCategory(category: MCPCategory): MCPCatalogEntry[] {
  return MCP_CATALOG.filter((e) => e.category === category)
}
