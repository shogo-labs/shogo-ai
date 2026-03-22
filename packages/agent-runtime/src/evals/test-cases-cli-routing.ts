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

import type { AgentEval } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  usedTool,
  neverUsedTool,
  execCommandContains,
  wroteEnvFile,
  responseContains,
  toolCallArgsContain,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared mock fixtures for CLI routing evals
// ---------------------------------------------------------------------------

const CLI_EXEC_MOCK: ToolMockMap = {
  exec: {
    type: 'pattern',
    patterns: [
      {
        match: { command: 'gh pr list' },
        response: {
          stdout: '#1\tFix login bug\tOPEN\t2026-03-18\n#2\tAdd dark mode\tOPEN\t2026-03-17\n#3\tUpdate deps\tMERGED\t2026-03-16',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'gh issue' },
        response: {
          stdout: '#10\tLogin page 500 error\topen\t2026-03-18\n#11\tMissing favicon\topen\t2026-03-17',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'gh run list' },
        response: {
          stdout: 'completed\tsuccess\tCI\tmain\t3m22s\t2026-03-18\ncompleted\tfailure\tCI\tfeature/dark-mode\t1m45s\t2026-03-17',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'glab mr list' },
        response: {
          stdout: '!1\tRefactor auth module\topen\t2026-03-18\n!2\tAdd CI pipeline\tmerged\t2026-03-16',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'glab pipeline' },
        response: {
          stdout: '#101\trunning\tmain\t2026-03-18T10:00:00Z\n#100\tsuccess\tmain\t2026-03-17T15:30:00Z',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'aws s3' },
        response: {
          stdout: '2026-03-01 my-bucket-prod\n2026-03-10 my-bucket-staging\n2026-02-15 backup-archive',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'aws ec2' },
        response: {
          stdout: 'i-0abc123\trunning\tt3.medium\tus-east-1a\nweb-server-prod\ni-0def456\tstopped\tt3.small\tus-east-1b\tdev-server',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'stripe customers' },
        response: {
          stdout: 'cus_ABC123\tjohn@example.com\tJohn Doe\ncus_DEF456\tjane@example.com\tJane Smith\ncus_GHI789\tbob@example.com\tBob Wilson',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'stripe' },
        response: {
          stdout: 'sub_123\tcus_ABC123\tactive\t$49.00/month\tPro Plan',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'oci' },
        response: {
          stdout: '{"data": [{"display-name": "web-server-1", "lifecycle-state": "RUNNING", "shape": "VM.Standard2.1"}]}',
          stderr: '',
          exitCode: 0,
        },
      },
    ],
    default: { stdout: '', stderr: '', exitCode: 0 },
  },
  write_file: {
    type: 'static',
    response: { ok: true, bytesWritten: 64 },
  },
  read_file: {
    type: 'static',
    response: { content: '', lines: 0 },
  },
  tool_search: {
    type: 'static',
    response: {
      results: [
        { name: 'github', description: 'GitHub managed integration (OAuth)', type: 'managed' },
      ],
    },
  },
  tool_install: {
    type: 'static',
    response: { ok: true, tools: ['GITHUB_LIST_REPOS', 'GITHUB_CREATE_ISSUE'] },
  },
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
      description: 'Saved GITHUB_TOKEN to .env file',
      points: 30,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'used-gh-pr-list',
      description: 'Ran gh pr list via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh pr list') || execCommandContains(r, 'gh pr '),
    },
    {
      id: 'no-inline-token',
      description: 'Did NOT inline token in exec command',
      points: 20,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'ghp_ABC123xyz789'),
    },
    {
      id: 'mentions-prs',
      description: 'Response mentions the PRs from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'login bug') || responseContains(r, 'dark mode') || responseContains(r, 'pull request'),
    },
  ],
  antiPatterns: ['Used tool_install instead of CLI', 'Inlined token in exec command'],
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
      description: 'Ran glab mr list via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'glab mr') || execCommandContains(r, 'glab mr list'),
    },
    {
      id: 'no-inline-token',
      description: 'Did NOT inline token in exec command',
      points: 20,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'glpat-'),
    },
    {
      id: 'mentions-mrs',
      description: 'Response references merge requests from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'merge request') || responseContains(r, 'refactor') || responseContains(r, 'auth module'),
    },
  ],
  antiPatterns: ['Used mcp_install for gitlab instead of CLI'],
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
      validate: (r) => execCommandContains(r, 'aws s3'),
    },
    {
      id: 'no-inline-secret',
      description: 'Did NOT inline secret key in exec command',
      points: 15,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'wJalrXUtnFEMI'),
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
      description: 'Saved STRIPE_API_KEY to .env',
      points: 30,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'STRIPE_API_KEY'),
    },
    {
      id: 'used-stripe-customers',
      description: 'Ran stripe customers list via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'stripe customers') || execCommandContains(r, 'stripe '),
    },
    {
      id: 'no-inline-key',
      description: 'Did NOT inline Stripe key in exec command',
      points: 20,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'sk_test_'),
    },
    {
      id: 'mentions-customers',
      description: 'Response mentions customers from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'customer') || responseContains(r, 'john') || responseContains(r, 'jane'),
    },
  ],
  antiPatterns: ['Used tool_install for stripe instead of CLI'],
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
      description: 'Saved OCI config (to .env or ~/.oci/config) via write_file',
      points: 30,
      phase: 'intention',
      validate: (r) => usedTool(r, 'write_file'),
    },
    {
      id: 'used-oci-cli',
      description: 'Ran oci command via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'oci'),
    },
    {
      id: 'mentions-instances',
      description: 'Response mentions compute instances from output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'web-server') || responseContains(r, 'instance') || responseContains(r, 'RUNNING'),
    },
    {
      id: 'reasonable-calls',
      description: 'Completed in <= 8 tool calls',
      points: 20,
      phase: 'execution',
      validate: (r) => r.toolCalls.length <= 8,
    },
  ],
  antiPatterns: ['Used mcp_install for Oracle Cloud'],
}

// ---------------------------------------------------------------------------
// CLI preference over managed integration (5 cases)
// ---------------------------------------------------------------------------

const ghPreferCli: AgentEval = {
  id: 'cli-prefer-gh-over-managed',
  name: 'CLI Routing: Prefer gh CLI over tool_install when token given',
  category: 'tool-routing',
  level: 2,
  input: 'Connect to GitHub and list my open issues. My token is ghp_PREFER_CLI_TEST_TOKEN_123.',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'used-write-file',
      description: 'Saved token to .env',
      points: 25,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'used-gh-cli',
      description: 'Used gh CLI via exec instead of tool_install',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh issue') || execCommandContains(r, 'gh '),
    },
    {
      id: 'did-not-tool-install',
      description: 'Did NOT use tool_install for GitHub',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'tool_install'),
    },
    {
      id: 'mentions-issues',
      description: 'Response mentions issues from CLI output',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'issue') || responseContains(r, 'login page') || responseContains(r, 'favicon'),
    },
  ],
  antiPatterns: ['Called tool_install("github") despite having a token'],
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
      description: 'Saved STRIPE_API_KEY to .env',
      points: 25,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'STRIPE_API_KEY'),
    },
    {
      id: 'used-stripe-cli',
      description: 'Used stripe CLI via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'stripe'),
    },
    {
      id: 'did-not-tool-install',
      description: 'Did NOT use tool_install for Stripe',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'tool_install'),
    },
    {
      id: 'mentions-subscription',
      description: 'Response mentions subscription creation',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'subscription') || responseContains(r, 'sub_'),
    },
  ],
  antiPatterns: ['Called tool_install for Stripe despite having API key'],
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
      description: 'Used glab pipeline via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'glab'),
    },
    {
      id: 'did-not-mcp-install',
      description: 'Did NOT use mcp_install for GitLab',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'mcp_install'),
    },
    {
      id: 'mentions-pipelines',
      description: 'Response mentions pipeline results',
      points: 20,
      phase: 'execution',
      validate: (r) => responseContains(r, 'pipeline') || responseContains(r, 'running') || responseContains(r, 'success'),
    },
  ],
  antiPatterns: ['Called mcp_install for GitLab MCP server despite having token'],
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
      validate: (r) => execCommandContains(r, 'aws s3'),
    },
    {
      id: 'no-managed-install',
      description: 'Did NOT use tool_install or mcp_install',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'tool_install') && neverUsedTool(r, 'mcp_install'),
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
      description: 'Saved GITHUB_TOKEN to .env',
      points: 25,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'used-gh-run',
      description: 'Used gh run list (or similar) via exec',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh run') || execCommandContains(r, 'gh workflow'),
    },
    {
      id: 'no-tool-install',
      description: 'Did NOT use tool_install',
      points: 25,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'tool_install'),
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
      description: 'Saved token to .env before running CLI',
      points: 40,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'no-token-in-command',
      description: 'Token does NOT appear in any exec command string',
      points: 40,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'ghp_INLINE_TEST_SECRET_456'),
    },
    {
      id: 'used-gh-cli',
      description: 'Still used gh CLI via exec',
      points: 20,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh '),
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
      description: 'Wrote token to .env (did not skip it)',
      points: 40,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'used-cli-not-managed',
      description: 'Used gh CLI, not tool_install',
      points: 30,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh ') && neverUsedTool(r, 'tool_install'),
    },
    {
      id: 'mentions-results',
      description: 'Response includes PR information',
      points: 30,
      phase: 'execution',
      validate: (r) => responseContains(r, 'pull request') || responseContains(r, 'PR') || responseContains(r, 'login bug'),
    },
  ],
  antiPatterns: ['Used tool_install/tool_search instead of saving token and using CLI'],
}

const fallbackToManaged: AgentEval = {
  id: 'cli-fallback-no-token',
  name: 'CLI Routing: Fall back to managed integration when no token given',
  category: 'tool-routing',
  level: 2,
  input: 'Can you connect to my GitHub and show me my repositories?',
  maxScore: 100,
  toolMocks: CLI_EXEC_MOCK,
  validationCriteria: [
    {
      id: 'searched-for-integration',
      description: 'Searched for GitHub integration via tool_search',
      points: 40,
      phase: 'intention',
      validate: (r) => usedTool(r, 'tool_search') || usedTool(r, 'tool_install'),
    },
    {
      id: 'did-not-write-env',
      description: 'Did NOT write to .env (no token was provided)',
      points: 30,
      phase: 'execution',
      validate: (r) => !wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'did-not-use-bare-gh',
      description: 'Did NOT blindly run gh CLI without a token',
      points: 30,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'gh pr') && !execCommandContains(r, 'gh issue') && !execCommandContains(r, 'gh repo'),
    },
  ],
  antiPatterns: ['Ran gh CLI without any token being configured'],
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
      description: 'Saved GITHUB_TOKEN to .env',
      points: 20,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'wrote-stripe-key',
      description: 'Saved STRIPE_API_KEY to .env',
      points: 20,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'STRIPE_API_KEY'),
    },
    {
      id: 'used-gh-cli',
      description: 'Used gh CLI for PRs',
      points: 15,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh pr') || execCommandContains(r, 'gh '),
    },
    {
      id: 'used-stripe-cli',
      description: 'Used stripe CLI for customers',
      points: 15,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'stripe'),
    },
    {
      id: 'no-inline-tokens',
      description: 'Neither token appears in exec commands',
      points: 15,
      phase: 'execution',
      validate: (r) => !execCommandContains(r, 'ghp_MULTI_GH_TOKEN') && !execCommandContains(r, 'sk_test_MULTI_STRIPE_KEY'),
    },
    {
      id: 'no-managed-install',
      description: 'Did not fall back to managed integrations',
      points: 15,
      phase: 'execution',
      validate: (r) => neverUsedTool(r, 'tool_install'),
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
      content: 'I\'ve saved your AWS credentials to `.env` and listed your S3 buckets:\n\n- my-bucket-prod (created 2026-03-01)\n- my-bucket-staging (created 2026-03-10)\n- backup-archive (created 2026-02-15)\n\nYou have 3 buckets total.',
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
      description: 'Saved GITHUB_TOKEN to .env (appending, not overwriting AWS keys)',
      points: 30,
      phase: 'intention',
      validate: (r) => wroteEnvFile(r, 'GITHUB_TOKEN'),
    },
    {
      id: 'preserved-aws-keys',
      description: 'Read existing .env before writing (to preserve AWS keys)',
      points: 20,
      phase: 'intention',
      validate: (r) => {
        const writes = r.toolCalls.filter(t => t.name === 'write_file')
        return writes.some(t => {
          const input = t.input as Record<string, any>
          const content = typeof input.content === 'string' ? input.content : ''
          return content.includes('AWS_ACCESS_KEY_ID') && content.includes('GITHUB_TOKEN')
        }) || usedTool(r, 'read_file')
      },
    },
    {
      id: 'used-gh-cli',
      description: 'Used gh CLI for PRs',
      points: 25,
      phase: 'execution',
      validate: (r) => execCommandContains(r, 'gh pr') || execCommandContains(r, 'gh '),
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
