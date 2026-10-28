// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CLI Routing Eval Test Cases
 *
 * Tests the agent's ability to correctly route tool usage through pre-installed
 * CLI tools (gh, glab, aws, stripe, oci) when the user provides access tokens.
 * The agent should save tokens to workspace .env, then use the CLI via exec.
 *
 * Three categories:
 * 1. Token-to-.env flow: User provides a token, agent saves to .env and uses CLI
 * 2. CLI preference: Agent prefers CLI over managed integrations when token is given
 * 3. Anti-patterns: Agent avoids inline tokens and falls back correctly
 */

import type { AgentEval, EvalResult } from './types'
import {
  cliExecMock,
  cmdRe,
  dateDaysAgo,
  daysAgo,
  execResult,
  type ExecMockPattern,
  type ToolMockMap,
  type ToolMockSpec,
} from './tool-mocks'
import {
  usedTool,
  neverUsedTool,
  delegatedTo,
  execCommands,
  execInlinesSecret,
  wroteEnvFile,
  wroteFileAnyRoute,
  readWorkspaceFile,
  responseContains,
  usedGhCli,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared mock fixtures for CLI routing evals
//
// The suite's premise is that gh/glab/aws/stripe/oci are pre-installed. The
// exec mock simulates those binaries (including `which`/`--version` probes)
// and answers their commands; everything else runs for real, so `.env`
// writes and `cat .env` reads hit the actual workspace.
// ---------------------------------------------------------------------------

const ok = (stdout: string) => execResult(stdout)

const SIMULATED_CLIS = ['glab', 'aws', 'stripe', 'oci']

const CLI_PATTERNS: ExecMockPattern[] = [
  ...SIMULATED_CLIS.flatMap((bin): ExecMockPattern[] => [
    { match: { command: `re:(?:^|[\\s;&|(])(which|command\\s+-v|type)\\s+${bin}\\b` }, response: ok(`/usr/local/bin/${bin}`) },
    { match: { command: `re:(?:^|[\\s;&|(/])${bin}\\s+(--version|version)\\b` }, response: ok(`${bin} version (simulated)`) },
  ]),
  { match: { command: cmdRe('glab', 'mr') }, response: ok(`!1\tRefactor auth module\topen\t${dateDaysAgo(1)}\n!2\tAdd CI pipeline\tmerged\t${dateDaysAgo(3)}`) },
  { match: { command: cmdRe('glab', 'ci') }, response: ok(`#101\trunning\tmain\t${daysAgo(0, 10)}\n#100\tsuccess\tmain\t${daysAgo(1, 15, 30)}`) },
  { match: { command: cmdRe('glab', 'pipeline') }, response: ok(`#101\trunning\tmain\t${daysAgo(0, 10)}\n#100\tsuccess\tmain\t${daysAgo(1, 15, 30)}`) },
  // REST fallback for GitLab (curl with the token read from the environment).
  { match: { command: 're:\\bcurl\\b[\\s\\S]*gitlab\\.com/api/v4[\\s\\S]*merge_requests' }, response: ok(JSON.stringify([{ iid: 1, title: 'Refactor auth module', state: 'opened' }, { iid: 2, title: 'Add CI pipeline', state: 'merged' }])) },
  { match: { command: 're:\\bcurl\\b[\\s\\S]*gitlab\\.com/api/v4[\\s\\S]*pipelines' }, response: ok(JSON.stringify([{ id: 101, status: 'running', ref: 'main' }, { id: 100, status: 'success', ref: 'main' }])) },
  { match: { command: cmdRe('aws', 's3') }, response: ok(`${dateDaysAgo(45)} 10:00:00 my-bucket-prod\n${dateDaysAgo(36)} 10:00:00 my-bucket-staging\n${dateDaysAgo(60)} 10:00:00 backup-archive`) },
  { match: { command: cmdRe('aws', 'ec2') }, response: ok('i-0abc123\trunning\tt3.medium\tus-east-1a\tweb-server-prod\ni-0def456\tstopped\tt3.small\tus-east-1b\tdev-server') },
  { match: { command: cmdRe('aws', 'sts') }, response: ok(JSON.stringify({ UserId: 'AIDAEXAMPLE', Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/dev' })) },
  { match: { command: cmdRe('stripe', 'customers') }, response: ok(JSON.stringify({ object: 'list', data: [{ id: 'cus_ABC123', email: 'john@example.com', name: 'John Doe' }, { id: 'cus_DEF456', email: 'jane@example.com', name: 'Jane Smith' }, { id: 'cus_GHI789', email: 'bob@example.com', name: 'Bob Wilson' }] }, null, 2)) },
  { match: { command: cmdRe('stripe', 'subscriptions') }, response: ok(JSON.stringify({ id: 'sub_1QxYz123', object: 'subscription', customer: 'cus_ABC123', status: 'active', items: { data: [{ price: { id: 'price_monthly_49', unit_amount: 4900, recurring: { interval: 'month' } } }] } }, null, 2)) },
  { match: { command: 're:\\bcurl\\b[\\s\\S]*api\\.stripe\\.com/v1/customers' }, response: ok(JSON.stringify({ object: 'list', data: [{ id: 'cus_ABC123', email: 'john@example.com', name: 'John Doe' }, { id: 'cus_DEF456', email: 'jane@example.com', name: 'Jane Smith' }, { id: 'cus_GHI789', email: 'bob@example.com', name: 'Bob Wilson' }] })) },
  { match: { command: 're:\\bcurl\\b[\\s\\S]*api\\.stripe\\.com/v1/subscriptions' }, response: ok(JSON.stringify({ id: 'sub_1QxYz123', object: 'subscription', customer: 'cus_ABC123', status: 'active' })) },
  { match: { command: cmdRe('oci') }, response: ok('{"data": [{"display-name": "web-server-1", "lifecycle-state": "RUNNING", "shape": "VM.Standard2.1"}]}') },
]

const GITHUB_CONNECT_MOCK: ToolMockSpec = {
  type: 'pattern',
  patterns: [
    {
      match: { token: 're:\\S' },
      response: { ok: true, connected: 'octocat/web-app', as: 'octocat', branch: 'main', files: 'already up to date with the repository' },
    },
  ],
  default: {
    ok: true,
    authorizeUrl: 'https://github.com/apps/shogo-ai/installations/new?state=eval',
    options: [
      'Open the link to authorize the Shogo GitHub App for this repository.',
      'Share a GitHub access token (fine-grained: Contents and Pull requests read/write; classic: repo scope). It is stored encrypted on the project connection.',
    ],
  },
}

function cliRoutingMocks(gh: { authenticated: boolean }): ToolMockMap {
  return {
    exec: cliExecMock({ patterns: CLI_PATTERNS, gh }),
    github_connect: GITHUB_CONNECT_MOCK,
    search_integrations: {
      type: 'static',
      response: {
        results: [
          { name: 'github', description: 'GitHub managed integration (OAuth)', type: 'managed' },
        ],
      },
    },
    connect: {
      type: 'static',
      response: { ok: true, tools: ['GITHUB_LIST_REPOS', 'GITHUB_CREATE_ISSUE'] },
    },
  }
}

/** The user gave a token: `gh` works once it's configured. */
const CLI_EXEC_MOCK = cliRoutingMocks({ authenticated: true })
/** No token anywhere: `gh` reports it isn't logged in. */
const CLI_EXEC_MOCK_NO_AUTH = cliRoutingMocks({ authenticated: false })

/** Ran `words` as a command (not just mentioned the word somewhere). */
function ranCommand(r: EvalResult, ...words: string[]): boolean {
  const re = new RegExp(cmdRe(...words).slice(3), 'i')
  return execCommands(r).some(c => re.test(c))
}

/**
 * Saved the GitHub token through a sanctioned route: `.env` (GITHUB_TOKEN or
 * GH_TOKEN) for the CLI, or `github_connect` with the token, which stores it
 * encrypted on the project connection.
 */
function savedGithubToken(r: EvalResult, token: string): boolean {
  return wroteEnvFile(r, 'GITHUB_TOKEN') || wroteEnvFile(r, 'GH_TOKEN') ||
    r.toolCalls.some(t => t.name === 'github_connect' && String((t.input as Record<string, unknown>)?.token ?? '') === token)
}

/** Listed PRs via gh, or via the GitHub REST API with the token from the environment. */
function listedPrs(r: EvalResult): boolean {
  return ranCommand(r, 'gh', 'pr') || ranCommand(r, 'gh', 'search', 'prs') ||
    execCommands(r).some(c => /\bcurl\b[\s\S]*api\.github\.com[\s\S]*\/(pulls|search\/issues)/.test(c))
}

function savedStripeKey(r: EvalResult): boolean {
  return wroteEnvFile(r, 'STRIPE_API_KEY') || wroteEnvFile(r, 'STRIPE_SECRET_KEY')
}

function usedStripe(r: EvalResult, resource: string): boolean {
  return ranCommand(r, 'stripe', resource) ||
    execCommands(r).some(c => new RegExp(`\\bcurl\\b[\\s\\S]*api\\.stripe\\.com/v1/${resource}`).test(c))
}

/**
 * Only a fingerprint is given, and OCI request signing needs the private key
 * itself, so asking for it is a correct answer.
 */
function askedForOciPrivateKey(r: EvalResult): boolean {
  const asked = r.toolCalls.some(t => t.name === 'ask_user' && /private key|\.pem/i.test(JSON.stringify(t.input)))
  return asked || /private key|\.pem\b/i.test(r.responseText ?? '')
}

/** Used glab, or the GitLab REST API via curl. */
function usedGitlab(r: EvalResult, resource: RegExp): boolean {
  return execCommands(r).some(c => (/(^|[\s;&|(/])glab\s/.test(c) && resource.test(c)) || /\bcurl\b[\s\S]*gitlab\.com\/api\/v4/.test(c) && resource.test(c))
}

// ---------------------------------------------------------------------------
// Token-to-.env flow (5 cases)
// ---------------------------------------------------------------------------

const ghTokenFlow: AgentEval = {
  id: 'cli-route-gh-token',
  name: 'CLI Routing: GitHub PAT → .env → gh CLI',
  category: 'tool-routing',
  level: 2,
  input: 'Here is my GitHub personal access token: ghp_ABC123xyz789. Can you list my open pull requests?',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-github-token',
      description: 'Saved the token via .env (GITHUB_TOKEN/GH_TOKEN) or github_connect',
      points: 30,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_ABC123xyz789'),
    },
    {
      id: 'used-gh-pr-list',
      description: 'Listed PRs via gh (or the GitHub API with the token from env)',
      points: 30,
      phase: 'execution',
      validate: (r) => listedPrs(r),
    },
    {
      id: 'no-inline-token',
      description: 'Did NOT inline token in exec command',
      points: 20,
      phase: 'execution',
      validate: (r) => !execInlinesSecret(r, 'ghp_ABC123xyz789'),
    },
    {
      id: 'mentions-prs',
      description: 'Response mentions the PRs from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'login bug') || responseContains(r, 'dark mode') || responseContains(r, 'pull request'),
    },
  ],
  antiPatterns: ['Used connect instead of CLI', 'Inlined token in exec command'],
}

const glabTokenFlow: AgentEval = {
  id: 'cli-route-glab-token',
  name: 'CLI Routing: GitLab token → .env → glab CLI',
  category: 'tool-routing',
  level: 2,
  input: 'My GitLab personal access token is glpat-xxxxxxxxxxxxxxxxxxxx. Show me my open merge requests.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-gitlab-token',
      description: 'Saved GITLAB_TOKEN to .env file',
      points: 30,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITLAB_TOKEN'),
    },
    {
      id: 'used-glab-mr',
      description: 'Listed MRs via glab (or the GitLab API with the token from env)',
      points: 30,
      phase: 'execution',
      validate: (r) => usedGitlab(r, /\bmr\b|merge_requests/),
    },
    {
      id: 'no-inline-token',
      description: 'Did NOT inline token in exec command',
      points: 20,
      phase: 'execution',
      validate: (r) => !execInlinesSecret(r, 'glpat-'),
    },
    {
      id: 'mentions-mrs',
      description: 'Response references merge requests from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'merge request') || responseContains(r, 'refactor') || responseContains(r, 'auth module'),
    },
  ],
  antiPatterns: ['Used connect for gitlab instead of CLI'],
}

const awsTokenFlow: AgentEval = {
  id: 'cli-route-aws-token',
  name: 'CLI Routing: AWS creds → .env → aws CLI',
  category: 'tool-routing',
  level: 2,
  input: 'Here are my AWS credentials. Access key: AKIAIOSFODNN7EXAMPLE, Secret key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY. List my S3 buckets.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-aws-access-key',
      description: 'Saved AWS_ACCESS_KEY_ID to .env',
      points: 20,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'AWS_ACCESS_KEY_ID'),
    },
    {
      id: 'wrote-env-aws-secret-key',
      description: 'Saved AWS_SECRET_ACCESS_KEY to .env',
      points: 20,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'AWS_SECRET_ACCESS_KEY'),
    },
    {
      id: 'used-aws-s3',
      description: 'Ran aws s3 ls via exec',
      points: 25,
      phase: 'execution',
      validate: (r) => ranCommand(r, 'aws', 's3'),
    },
    {
      id: 'no-inline-secret',
      description: 'Did NOT inline secret key in exec command',
      points: 15,
      phase: 'execution',
      validate: (r) => !execInlinesSecret(r, 'wJalrXUtnFEMI'),
    },
    {
      id: 'mentions-buckets',
      description: 'Response mentions S3 buckets from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'bucket') || responseContains(r, 'my-bucket'),
    },
  ],
  antiPatterns: ['Inlined AWS secret in exec command'],
}

const stripeTokenFlow: AgentEval = {
  id: 'cli-route-stripe-token',
  name: 'CLI Routing: Stripe key → .env → stripe CLI',
  category: 'tool-routing',
  level: 2,
  input: 'My Stripe API key is sk_test_4eC39HqLyjWDarjtT1zdp7dc. Can you list my customers?',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-stripe-key',
      description: 'Saved the Stripe key (STRIPE_API_KEY/STRIPE_SECRET_KEY) to .env',
      points: 30,
      phase: 'intention',
      validate: (r) => savedStripeKey(r),
    },
    {
      id: 'used-stripe-customers',
      description: 'Listed customers via the stripe CLI (or the Stripe API with the key from env)',
      points: 30,
      phase: 'execution',
      validate: (r) => usedStripe(r, 'customers'),
    },
    {
      id: 'no-inline-key',
      description: 'Did NOT inline Stripe key in exec command',
      points: 20,
      phase: 'execution',
      validate: (r) => !execInlinesSecret(r, 'sk_test_'),
    },
    {
      id: 'mentions-customers',
      description: 'Response mentions customers from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'customer') || responseContains(r, 'john') || responseContains(r, 'jane'),
    },
  ],
  antiPatterns: ['Used connect for stripe instead of CLI'],
}

const ociTokenFlow: AgentEval = {
  id: 'cli-route-oci-token',
  name: 'CLI Routing: OCI config → .env → oci CLI',
  category: 'tool-routing',
  level: 3,
  input: 'I need to use Oracle Cloud. My tenancy OCID is ocid1.tenancy.oc1..aaaaexample, user OCID is ocid1.user.oc1..aaaaexample, region is us-ashburn-1, and my API key fingerprint is aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99. Please list my compute instances.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-config-or-env',
      description: 'Saved OCI config (to .env or ~/.oci/config)',
      points: 30,
      phase: 'intention',
      validate: (r) => wroteFileAnyRoute(r, (p) => p === '.env' || p.endsWith('/.env') || /\.oci\/config$/.test(p)),
    },
    {
      id: 'used-oci-cli',
      description: 'Ran oci or called the OCI API, or asked for the private key signing needs',
      points: 30,
      phase: 'execution',
      validate: (r) => ranCommand(r, 'oci') ||
        execCommands(r).some(c => /\bcurl\b[\s\S]*oraclecloud\.com/.test(c)) ||
        askedForOciPrivateKey(r),
    },
    {
      id: 'mentions-instances',
      description: 'Response reports the instances from the output, or asks for the private key',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'web-server') || responseContains(r, 'RUNNING') || askedForOciPrivateKey(r),
    },
    {
      id: 'reasonable-calls',
      description: 'Completed in <= 8 tool calls',
      points: 20,
      phase: 'execution',
      validate: (r) => r.toolCalls.length <= 8,
    },
  ],
  antiPatterns: ['Used connect for Oracle Cloud'],
}

// ---------------------------------------------------------------------------
// CLI preference over managed integration (5 cases)
// ---------------------------------------------------------------------------

const ghPreferCli: AgentEval = {
  id: 'cli-prefer-gh-over-managed',
  name: 'CLI Routing: Prefer gh CLI over connect when token given',
  category: 'tool-routing',
  level: 2,
  input: 'Connect to GitHub and list my open issues. My token is ghp_PREFER_CLI_TEST_TOKEN_123.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'used-write-file',
      description: 'Saved the token via .env or github_connect',
      points: 25,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_PREFER_CLI_TEST_TOKEN_123'),
    },
    {
      id: 'used-gh-cli',
      description: 'Used gh CLI via exec instead of connect',
      points: 30,
      phase: 'execution',
      validate: (r) => ranCommand(r, 'gh'),
    },
    {
      id: 'did-not-tool-install',
      description: 'Did NOT use connect for GitHub',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-issues',
      description: 'Response mentions issues from CLI output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'issue') || responseContains(r, 'login page') || responseContains(r, 'favicon'),
    },
  ],
  antiPatterns: ['Called connect("github") despite having a token'],
}

const ghIssuesWithoutToken: AgentEval = {
  id: 'cli-gh-issues-without-token',
  name: 'CLI Routing: GitHub issues use gh even without a PAT in the prompt',
  category: 'tool-routing',
  level: 2,
  input: 'Check my GitHub issues and show me the open bugs',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'used-gh-cli',
      description: 'Used gh issue via exec',
      points: 50,
      phase: 'execution',
      validate: (r) => usedGhCli(r, 'issue') || ranCommand(r, 'gh'),
    },
    {
      id: 'did-not-tool-install',
      description: 'Did NOT use connect for GitHub',
      points: 30,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-issues',
      description: 'Response mentions issues from CLI output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'issue') || responseContains(r, 'login page') || responseContains(r, 'favicon') || responseContains(r, 'bug'),
    },
  ],
  antiPatterns: ['Called connect("github") or GITHUB_* Composio tools for listing issues'],
}

const stripePreferCli: AgentEval = {
  id: 'cli-prefer-stripe-over-managed',
  name: 'CLI Routing: Prefer stripe CLI over Composio when key given',
  category: 'tool-routing',
  level: 2,
  input: 'I need to create a Stripe subscription for a customer. My API key is sk_test_PREFER_CLI_TEST_123. The customer ID is cus_ABC123, use the price price_monthly_49.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-stripe',
      description: 'Saved the Stripe key (STRIPE_API_KEY/STRIPE_SECRET_KEY) to .env',
      points: 25,
      phase: 'intention',
      validate: (r) => savedStripeKey(r),
    },
    {
      id: 'used-stripe-cli',
      description: 'Created the subscription via the stripe CLI (or the Stripe API with the key from env)',
      points: 30,
      phase: 'execution',
      validate: (r) => usedStripe(r, 'subscriptions'),
    },
    {
      id: 'did-not-tool-install',
      description: 'Did NOT use connect for Stripe',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-subscription',
      description: 'Response mentions subscription creation',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'subscription') || responseContains(r, 'sub_'),
    },
  ],
  antiPatterns: ['Called connect for Stripe despite having API key'],
}

const glabPreferCli: AgentEval = {
  id: 'cli-prefer-glab-over-mcp',
  name: 'CLI Routing: Prefer glab CLI over MCP server when token given',
  category: 'tool-routing',
  level: 2,
  input: 'List my GitLab CI/CD pipelines. Here is my token: glpat-PREFER_CLI_TEST_xyz.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-gitlab',
      description: 'Saved GITLAB_TOKEN to .env',
      points: 25,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITLAB_TOKEN'),
    },
    {
      id: 'used-glab-cli',
      description: 'Listed pipelines via glab (or the GitLab API with the token from env)',
      points: 30,
      phase: 'execution',
      validate: (r) => usedGitlab(r, /\bci\b|pipeline/),
    },
    {
      id: 'did-not-mcp-install',
      description: 'Did NOT use connect for GitLab',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-pipelines',
      description: 'Response mentions pipeline results',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'pipeline') || responseContains(r, 'running') || responseContains(r, 'success'),
    },
  ],
  antiPatterns: ['Called connect for GitLab MCP server despite having token'],
}

const awsPreferCli: AgentEval = {
  id: 'cli-prefer-aws-s3',
  name: 'CLI Routing: Use aws CLI for S3 when creds given',
  category: 'tool-routing',
  level: 2,
  input: 'Show my S3 buckets. AWS access key: AKIAIOSFODNN7EXAMPLE, secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-aws',
      description: 'Saved AWS credentials to .env',
      points: 25,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'AWS_ACCESS_KEY_ID') && wroteEnvFile(r, 'AWS_SECRET_ACCESS_KEY'),
    },
    {
      id: 'used-aws-s3',
      description: 'Used aws s3 via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => ranCommand(r, 'aws', 's3'),
    },
    {
      id: 'no-managed-install',
      description: 'Did NOT use connect',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-buckets',
      description: 'Response mentions S3 buckets',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'bucket') || responseContains(r, 'my-bucket'),
    },
  ],
}

const ghActionsPreferCli: AgentEval = {
  id: 'cli-prefer-gh-actions',
  name: 'CLI Routing: Use gh CLI for Actions runs when token given',
  category: 'tool-routing',
  level: 2,
  input: 'Check my GitHub Actions workflow runs. My personal access token is ghp_ACTIONS_TOKEN_789.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-github',
      description: 'Saved the token via .env or github_connect',
      points: 25,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_ACTIONS_TOKEN_789'),
    },
    {
      id: 'used-gh-run',
      description: 'Used gh run list (or similar) via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => ranCommand(r, 'gh', 'run') || ranCommand(r, 'gh', 'workflow') ||
        execCommands(r).some(c => /\bcurl\b[\s\S]*api\.github\.com[\s\S]*actions\/runs/.test(c)),
    },
    {
      id: 'no-tool-install',
      description: 'Did NOT use connect',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-runs',
      description: 'Response mentions workflow runs',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'workflow') || responseContains(r, 'run') || responseContains(r, 'CI'),
    },
  ],
}

// ---------------------------------------------------------------------------
// Anti-pattern tests (3 cases)
// ---------------------------------------------------------------------------

const antiPatternInlineToken: AgentEval = {
  id: 'cli-anti-inline-token',
  name: 'CLI Routing: Never inline token in exec command',
  category: 'tool-routing',
  level: 2,
  input: 'Use this GitHub token ghp_INLINE_TEST_SECRET_456 to check my repos with gh.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env-first',
      description: 'Saved token to .env (or github_connect) before running CLI',
      points: 40,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_INLINE_TEST_SECRET_456'),
    },
    {
      id: 'no-token-in-command',
      description: 'Token does NOT appear in any exec command string',
      points: 40,
      phase: 'execution',
      validate: (r) => !execInlinesSecret(r, 'ghp_INLINE_TEST_SECRET_456'),
    },
    {
      id: 'used-gh-cli',
      description: 'Still used gh CLI via exec',
      points: 20,
      phase: 'execution',
      validate: (r) => ranCommand(r, 'gh'),
    },
  ],
  antiPatterns: ['Passed token as GITHUB_TOKEN=xxx gh ... in command string'],
}

const antiPatternSkipEnv: AgentEval = {
  id: 'cli-anti-skip-env-use-managed',
  name: 'CLI Routing: Do not skip .env when token is explicitly provided',
  category: 'tool-routing',
  level: 2,
  input: 'My GitHub token is ghp_SKIP_ENV_TEST_789. Please list open PRs in my repo.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-env',
      description: 'Saved the token to .env or github_connect (did not skip it)',
      points: 40,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_SKIP_ENV_TEST_789'),
    },
    {
      id: 'used-cli-not-managed',
      description: 'Used gh CLI, not connect',
      points: 30,
      phase: 'execution',
      validate: (r) => listedPrs(r) && neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
    {
      id: 'mentions-results',
      description: 'Response includes PR information',
      points: 30,
      phase: 'execution',
      validate: (r) => responseContains(r, 'pull request') || responseContains(r, 'PR') || responseContains(r, 'login bug'),
    },
  ],
  antiPatterns: ['Used connect/search_integrations instead of saving token and using CLI'],
}

const fallbackToManaged: AgentEval = {
  id: 'cli-fallback-no-token',
  name: 'CLI Routing: No token — use gh if authed, else offer github_connect',
  category: 'tool-routing',
  level: 2,
  input: 'Can you connect to my GitHub and show me my repositories?',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK_NO_AUTH,
  validationCriteria: [
    {
      id: 'tried-gh-or-github-connect',
      description: 'Checked gh (CLI-first for GitHub) or started github_connect',
      points: 40,
      phase: 'intention',
      validate: (r) => ranCommand(r, 'gh') || usedTool(r, 'github_connect'),
    },
    {
      id: 'did-not-write-env',
      description: 'Did NOT write a GitHub token to .env (none was provided)',
      points: 20,
      phase: 'execution',
      validate: (r) => !wroteEnvFile(r, 'GITHUB_TOKEN') && !wroteEnvFile(r, 'GH_TOKEN'),
    },
    {
      id: 'explained-auth-step',
      description: 'Told the user how to authorize (GitHub App link or a token) instead of inventing repos',
      points: 40,
      phase: 'execution',
      validate: (r) => /authoriz|token|sign in|log in|login|link|install the/i.test(r.responseText) &&
        !/octocat\/web-app/i.test(r.responseText),
    },
  ],
  antiPatterns: ['Listed repositories that no tool returned', 'Wrote a placeholder token to .env'],
}

// ---------------------------------------------------------------------------
// Multi-token tests (2 cases)
// ---------------------------------------------------------------------------

const multiTokenSingleTurn: AgentEval = {
  id: 'cli-multi-token-single-turn',
  name: 'CLI Routing: Multiple tokens in one message',
  category: 'tool-routing',
  level: 3,
  input: 'I have two things: my GitHub PAT is ghp_MULTI_GH_TOKEN and my Stripe key is sk_test_MULTI_STRIPE_KEY. First list my GitHub PRs, then list my Stripe customers.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'wrote-github-token',
      description: 'Saved the GitHub token via .env or github_connect',
      points: 20,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_MULTI_GH_TOKEN'),
    },
    {
      id: 'wrote-stripe-key',
      description: 'Saved the Stripe key to .env',
      points: 20,
      phase: 'intention',
      validate: (r) => savedStripeKey(r),
    },
    {
      id: 'used-gh-cli',
      description: 'Used gh CLI for PRs',
      points: 15,
      phase: 'execution',
      validate: (r) => listedPrs(r),
    },
    {
      id: 'used-stripe-cli',
      description: 'Used stripe CLI (or API with env key) for customers',
      points: 15,
      phase: 'execution',
      validate: (r) => usedStripe(r, 'customers'),
    },
    {
      id: 'no-inline-tokens',
      description: 'Neither token appears in exec commands',
      points: 15,
      phase: 'execution',
      validate: (r) => !execInlinesSecret(r, 'ghp_MULTI_GH_TOKEN') && !execInlinesSecret(r, 'sk_test_MULTI_STRIPE_KEY'),
    },
    {
      id: 'no-managed-install',
      description: 'Did not fall back to managed integrations',
      points: 15,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'connect') && !delegatedTo(r, 'integration'),
    },
  ],
}

const multiTokenMultiTurn: AgentEval = {
  id: 'cli-multi-token-multi-turn',
  name: 'CLI Routing: Add second token in follow-up turn',
  category: 'tool-routing',
  level: 3,
  input: 'Now I also want to use GitHub. My PAT is ghp_SECOND_TOKEN_XYZ. List my open PRs.',
  conversationHistory: [
    {
      role: 'user',
      content: 'My AWS access key is AKIAIOSFODNN7EXAMPLE and secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY. List my S3 buckets.',
    },
    {
      role: 'assistant',
      content: `I've saved your AWS credentials to \`.env\` (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) and ran \`aws s3 ls\`:\n\n- my-bucket-prod (created ${dateDaysAgo(45)})\n- my-bucket-staging (created ${dateDaysAgo(36)})\n- backup-archive (created ${dateDaysAgo(60)})\n\nYou have 3 buckets total.`,
    },
  ],
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  workspaceFiles: {
    '.env': 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
  },
  validationCriteria: [
    {
      id: 'wrote-github-token',
      description: 'Saved the GitHub token via .env (GITHUB_TOKEN/GH_TOKEN) or github_connect',
      points: 30,
      phase: 'intention',
      validate: (r) => savedGithubToken(r, 'ghp_SECOND_TOKEN_XYZ'),
    },
    {
      id: 'preserved-aws-keys',
      description: 'The AWS keys are still in .env after this turn (appended, not overwritten)',
      points: 20,
      phase: 'execution',
      validate: (r) => {
        const env = readWorkspaceFile(r, '.env')
        if (env) return env.includes('AWS_ACCESS_KEY_ID') && env.includes('AWS_SECRET_ACCESS_KEY')
        // No workspace snapshot: fall back to what was written.
        return !r.toolCalls.some(t => t.name === 'write_file' && /(^|\/)\.env$/.test(String((t.input as Record<string, unknown>)?.path ?? '')) &&
          !String((t.input as Record<string, unknown>)?.content ?? '').includes('AWS_ACCESS_KEY_ID'))
      },
    },
    {
      id: 'used-gh-cli',
      description: 'Used gh CLI for PRs',
      points: 25,
      phase: 'execution',
      validate: (r) => listedPrs(r),
    },
    {
      id: 'mentions-prs',
      description: 'Response mentions PR results',
      points: 25,
      phase: 'execution',
      validate: (r) => responseContains(r, 'pull request') || responseContains(r, 'PR') || responseContains(r, 'login bug'),
    },
  ],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const CLI_ROUTING_EVALS: AgentEval[] = [
  // Token-to-.env flow
  ghTokenFlow,
  glabTokenFlow,
  awsTokenFlow,
  stripeTokenFlow,
  ociTokenFlow,
  // CLI preference over managed
  ghPreferCli,
  ghIssuesWithoutToken,
  stripePreferCli,
  glabPreferCli,
  awsPreferCli,
  ghActionsPreferCli,
  // Anti-patterns
  antiPatternInlineToken,
  antiPatternSkipEnv,
  fallbackToManaged,
  // Multi-token
  multiTokenSingleTurn,
  multiTokenMultiTurn,
]
