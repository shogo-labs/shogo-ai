/**
 * Agent Recipes
 *
 * Pre-configured combinations of template + MCP servers + channel + schedule
 * that give users a complete, ready-to-run agent with one click.
 * Each recipe includes the setup steps and required credentials.
 */

export interface AgentRecipe {
  id: string
  name: string
  description: string
  category: RecipeCategory
  icon: string
  /** Template ID from the templates registry */
  templateId: string
  /** MCP server IDs to auto-enable from the catalog */
  mcpServers: string[]
  /** Recommended channel type */
  channel?: string
  /** Heartbeat interval override (seconds) */
  heartbeatInterval: number
  /** Environment variables needed across all MCP servers */
  requiredCredentials: Array<{
    key: string
    label: string
    description: string
    source: string
  }>
  /** Tags for searchability */
  tags: string[]
  /** Example conversations to show users what this agent does */
  examplePrompts: string[]
}

export type RecipeCategory =
  | 'quick-start'
  | 'developer'
  | 'business'
  | 'personal'

export const RECIPE_CATEGORIES: Record<RecipeCategory, { label: string; icon: string }> = {
  'quick-start': { label: 'Quick Start', icon: '⚡' },
  developer: { label: 'Developer Tools', icon: '🛠️' },
  business: { label: 'Business & Growth', icon: '📈' },
  personal: { label: 'Personal & Lifestyle', icon: '🏠' },
}

export const AGENT_RECIPES: AgentRecipe[] = [
  // ── Quick Start (zero or minimal config) ───────────────────────────
  {
    id: 'research-assistant',
    name: 'Research Assistant',
    description: 'A ready-to-go research agent that searches the web, synthesizes information, and delivers daily briefings on topics you care about.',
    category: 'quick-start',
    icon: '📚',
    templateId: 'research-agent',
    mcpServers: ['brave-search'],
    heartbeatInterval: 3600,
    requiredCredentials: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        description: 'Free tier available — 2,000 queries/month',
        source: 'https://brave.com/search/api/',
      },
    ],
    tags: ['research', 'search', 'briefing'],
    examplePrompts: [
      'Research the latest developments in AI agent frameworks',
      'What are the top trending topics on Hacker News today?',
      'Compare React Server Components vs Astro for a new project',
    ],
  },
  {
    id: 'personal-todo',
    name: 'Personal Task Manager',
    description: 'A simple personal assistant that tracks tasks, sends reminders, and keeps you organized via Telegram.',
    category: 'quick-start',
    icon: '✅',
    templateId: 'personal-assistant',
    mcpServers: [],
    channel: 'telegram',
    heartbeatInterval: 1800,
    requiredCredentials: [],
    tags: ['tasks', 'reminders', 'simple'],
    examplePrompts: [
      'Add a task: Buy groceries by Friday',
      'What tasks do I have this week?',
      'Mark "buy groceries" as done',
    ],
  },

  // ── Developer Tools ────────────────────────────────────────────────
  {
    id: 'github-ops-bot',
    name: 'GitHub Ops Bot',
    description: 'Watches your repos for CI failures, reviews PRs, and posts updates to Slack or Discord. The complete GitHub operations companion.',
    category: 'developer',
    icon: '🐙',
    templateId: 'github-monitor',
    mcpServers: ['github', 'slack'],
    channel: 'discord',
    heartbeatInterval: 900,
    requiredCredentials: [
      {
        key: 'GITHUB_TOKEN',
        label: 'GitHub Personal Access Token',
        description: 'Needs repo read access. Create at Settings > Developer settings > Personal access tokens.',
        source: 'https://github.com/settings/tokens',
      },
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack Bot Token (optional)',
        description: 'For posting alerts to Slack. Skip if using Discord.',
        source: 'https://api.slack.com/apps',
      },
    ],
    tags: ['github', 'ci', 'slack', 'ops'],
    examplePrompts: [
      'Check the status of my-org/my-repo',
      'Are there any failing CI checks on main?',
      'List open PRs that need review',
    ],
  },
  {
    id: 'devops-watchdog',
    name: 'DevOps Watchdog',
    description: 'Monitors your infrastructure health, tracks errors in Sentry, and alerts your team on Discord when things go wrong.',
    category: 'developer',
    icon: '🔍',
    templateId: 'system-monitor',
    mcpServers: ['sentry'],
    channel: 'discord',
    heartbeatInterval: 600,
    requiredCredentials: [
      {
        key: 'SENTRY_AUTH_TOKEN',
        label: 'Sentry Auth Token',
        description: 'For monitoring application errors',
        source: 'https://sentry.io/settings/auth-tokens/',
      },
      {
        key: 'SENTRY_ORG',
        label: 'Sentry Organization',
        description: 'Your Sentry organization slug',
        source: 'https://sentry.io/settings/',
      },
    ],
    tags: ['monitoring', 'sentry', 'devops', 'alerts'],
    examplePrompts: [
      'What are the top errors in the last hour?',
      'Is the API healthy?',
      'Show me error trends for this week',
    ],
  },
  {
    id: 'code-reviewer',
    name: 'Automated Code Reviewer',
    description: 'Reviews pull requests automatically — checks for security issues, code quality, and test coverage, then posts comments on GitHub.',
    category: 'developer',
    icon: '🔍',
    templateId: 'pr-reviewer',
    mcpServers: ['github'],
    heartbeatInterval: 900,
    requiredCredentials: [
      {
        key: 'GITHUB_TOKEN',
        label: 'GitHub Token',
        description: 'Needs repo read + write:discussion access',
        source: 'https://github.com/settings/tokens',
      },
    ],
    tags: ['code-review', 'github', 'quality'],
    examplePrompts: [
      'Review the latest PR on my-org/my-repo',
      'What PRs are waiting for review?',
      'Check PR #42 for security issues',
    ],
  },

  // ── Business & Growth ──────────────────────────────────────────────
  {
    id: 'daily-news-briefing',
    name: 'Daily News Briefing',
    description: 'Curates a daily digest of news on your industry, delivered every morning to Telegram with summaries and links.',
    category: 'business',
    icon: '📰',
    templateId: 'news-digest',
    mcpServers: ['brave-search', 'playwright'],
    channel: 'telegram',
    heartbeatInterval: 3600,
    requiredCredentials: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        description: 'For news search',
        source: 'https://brave.com/search/api/',
      },
    ],
    tags: ['news', 'daily', 'briefing'],
    examplePrompts: [
      'What are the top AI stories today?',
      'Research what happened with OpenAI this week',
      'Show me trending startup news',
    ],
  },
  {
    id: 'competitor-tracker',
    name: 'Competitor Tracker',
    description: 'Monitors competitor websites and news for changes — pricing updates, new features, press releases, and job postings.',
    category: 'business',
    icon: '🕵️',
    templateId: 'competitive-intel',
    mcpServers: ['brave-search', 'playwright'],
    heartbeatInterval: 43200,
    requiredCredentials: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        description: 'For web search',
        source: 'https://brave.com/search/api/',
      },
    ],
    tags: ['competitors', 'intelligence', 'market'],
    examplePrompts: [
      'What did our competitors announce this week?',
      'Check if Competitor X changed their pricing',
      'Show me competitive landscape summary',
    ],
  },
  {
    id: 'personal-crm',
    name: 'Personal CRM',
    description: 'Tracks contacts and relationships via Gmail and Google Calendar. Reminds you to follow up with people and prepares meeting context.',
    category: 'business',
    icon: '🤝',
    templateId: 'personal-assistant',
    mcpServers: ['gmail', 'google-calendar'],
    channel: 'email',
    heartbeatInterval: 3600,
    requiredCredentials: [
      {
        key: 'GMAIL_CREDENTIALS',
        label: 'Gmail OAuth Credentials',
        description: 'For reading and sending emails',
        source: 'https://console.cloud.google.com/apis/credentials',
      },
      {
        key: 'GOOGLE_CALENDAR_CREDENTIALS',
        label: 'Google Calendar OAuth Credentials',
        description: 'For calendar access',
        source: 'https://console.cloud.google.com/apis/credentials',
      },
    ],
    tags: ['crm', 'contacts', 'email', 'calendar'],
    examplePrompts: [
      'Who should I follow up with this week?',
      'Prepare me for my meeting with John at 2pm',
      'When did I last talk to Sarah?',
    ],
  },

  // ── Personal & Lifestyle ───────────────────────────────────────────
  {
    id: 'habit-coach',
    name: 'Habit Coach',
    description: 'Tracks your daily habits via Telegram, celebrates streaks, and sends check-in reminders morning and evening.',
    category: 'personal',
    icon: '✅',
    templateId: 'habit-tracker',
    mcpServers: [],
    channel: 'telegram',
    heartbeatInterval: 3600,
    requiredCredentials: [],
    tags: ['habits', 'health', 'tracking'],
    examplePrompts: [
      'Add a new habit: Meditate for 10 minutes',
      'Log today\'s habits',
      'Show me my streak report',
    ],
  },
  {
    id: 'meeting-assistant',
    name: 'Meeting Assistant',
    description: 'Prepares agendas from your calendar, takes meeting notes, and tracks action items with deadlines.',
    category: 'personal',
    icon: '📝',
    templateId: 'meeting-notes',
    mcpServers: ['google-calendar', 'google-drive'],
    heartbeatInterval: 1800,
    requiredCredentials: [
      {
        key: 'GOOGLE_CALENDAR_CREDENTIALS',
        label: 'Google Calendar Credentials',
        description: 'For calendar access',
        source: 'https://console.cloud.google.com/apis/credentials',
      },
    ],
    tags: ['meetings', 'notes', 'calendar'],
    examplePrompts: [
      'What meetings do I have today?',
      'Prepare an agenda for my 2pm meeting',
      'What action items are overdue?',
    ],
  },
]
