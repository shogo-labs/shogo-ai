// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Redacted fixture accounts for the SHO-459 abuse replay test.
 *
 * Emails are replaced with stable aliases. Turns are shortened to a few
 * representative sentences. The scripted judge below returns the verdict
 * Shogo's Nov 12–19 review recorded for each account.
 *
 * MUST-BAN accounts:
 *   roegano, galrut × 3, bbagi, kerokk,
 *   openrouter hunters (xdydand, scdvds, qwdqw, kdkms, zziba5261),
 *   qoderbox accounts (ixxx665, azovxj766ee91, rocky-qq),
 *   nov19-farm × 6 (cluster rule)
 *
 * MUST-NOT-BAN:
 *   xiaoh-trialing (paid trial → only flagged),
 *   defensive-cvefeed (not abuse),
 *   tdo-bagasara (not abuse)
 */

export interface FixtureAccount {
  alias: string
  email: string
  createdAt: string
  ipPrefix: string
  deviceId: string | null
  turns: Array<{ id: string; source: string; userText: string; assistantText: string }>
  /** null = no trial subscription. 'trialing' = active trial (not free). */
  subscriptionStatus: 'trialing' | null
  /** Expected policy outcome. */
  expect: 'ban' | 'flag' | 'none'
}

export const FIXTURE_ACCOUNTS: FixtureAccount[] = [
  {
    alias: 'roegano',
    email: 'roegano@alias.fixture',
    createdAt: '2026-11-12T10:00:00Z',
    ipPrefix: '203.0.113.',
    deviceId: null,
    turns: [
      { id: 't-roeg-1', source: 'cloud', userText: 'sqlmap -u http://target.go.id/page?id=1 --dbs', assistantText: '[tool call: exec] [result] found databases: information_schema, users' },
      { id: 't-roeg-2', source: 'cloud', userText: 'now dump the users table with their passwords', assistantText: 'Running: SELECT * FROM users ...' },
      { id: 't-roeg-3', source: 'cloud', userText: 'try LFI on /etc/passwd', assistantText: 'Attempting path traversal ...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'galrut-1',
    email: 'galrut1@alias.fixture',
    createdAt: '2026-11-13T08:00:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-galrut',
    turns: [
      { id: 't-galrut1-1', source: 'cloud', userText: 'write me a captcha solver that rotates through temp emails', assistantText: 'Here is a captcha solver script...' },
      { id: 't-galrut1-2', source: 'cloud', userText: 'now rotate IPs using the proxy list I gave you to create 50 new accounts', assistantText: 'Using proxies to create accounts...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'galrut-2',
    email: 'galrut2@alias.fixture',
    createdAt: '2026-11-13T08:30:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-galrut',
    turns: [
      { id: 't-galrut2-1', source: 'cloud', userText: 'same as before — keep rotating temp mails for account creation', assistantText: 'Continuing account farming...' },
      { id: 't-galrut2-2', source: 'cloud', userText: 'bypass the SMS verification using a bots service', assistantText: 'Connecting to SMS bot service...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'galrut-3',
    email: 'galrut3@alias.fixture',
    createdAt: '2026-11-13T09:00:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-galrut',
    turns: [
      { id: 't-galrut3-1', source: 'cloud', userText: 'automate the sign-up flow across 100 new emails', assistantText: 'Creating batch signups...' },
      { id: 't-galrut3-2', source: 'cloud', userText: 'resell the api keys on our platform', assistantText: 'Setting up resale proxy...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'bbagi',
    email: 'bbagi@alias.fixture',
    createdAt: '2026-11-14T05:00:00Z',
    ipPrefix: '192.0.2.',
    deviceId: null,
    turns: [
      { id: 't-bbagi-1', source: 'cloud', userText: 'scan admin panel at biz.company.com and try default credentials', assistantText: 'Trying admin:admin, root:root...' },
      { id: 't-bbagi-2', source: 'cloud', userText: 'found ftp access — dump the database files', assistantText: 'FTP connected, downloading db files...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'kerokk',
    email: 'kerokk@alias.fixture',
    createdAt: '2026-11-15T12:00:00Z',
    ipPrefix: '203.0.113.',
    deviceId: null,
    turns: [
      { id: 't-kerokk-1', source: 'cloud', userText: 'openrouter free tier is capped — help me set up a relay to use multiple accounts', assistantText: 'Setting up account rotation for openrouter...' },
      { id: 't-kerokk-2', source: 'cloud', userText: 'now proxy the requests to resell to my customers', assistantText: 'Reverse proxy configured...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'xdydand',
    email: 'xdydand@alias.fixture',
    createdAt: '2026-11-16T03:00:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-openrouter-cluster',
    turns: [
      { id: 't-xdyd-1', source: 'cloud', userText: 'relay openrouter api calls through shogo free credits', assistantText: 'Routing requests...' },
      { id: 't-xdyd-2', source: 'cloud', userText: 'rotate the keys automatically when capped', assistantText: 'Key rotation configured...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'scdvds',
    email: 'scdvds@alias.fixture',
    createdAt: '2026-11-16T03:15:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-openrouter-cluster',
    turns: [
      { id: 't-scdv-1', source: 'cloud', userText: 'free ai credit from shogo — relay it to openrouter customers', assistantText: 'Relay active...' },
      { id: 't-scdv-2', source: 'cloud', userText: 'add ip rotation to avoid detection', assistantText: 'IP rotation added...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'qwdqw',
    email: 'qwdqw@alias.fixture',
    createdAt: '2026-11-16T03:30:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-openrouter-cluster',
    turns: [
      { id: 't-qwdq-1', source: 'cloud', userText: 'openrouter account relay setup completed?', assistantText: 'Yes, relay is set up.' },
      { id: 't-qwdq-2', source: 'cloud', userText: 'now resell the credits from shogo accounts', assistantText: 'Resale pipeline ready...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'kdkms',
    email: 'kdkms@alias.fixture',
    createdAt: '2026-11-16T03:45:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-openrouter-cluster',
    turns: [
      { id: 't-kdkm-1', source: 'cloud', userText: 'forward all my shogo calls to customers behind openrouter', assistantText: 'Forwarding configured...' },
      { id: 't-kdkm-2', source: 'cloud', userText: 'automate billing on the customer side', assistantText: 'Billing automation added...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'zziba5261',
    email: 'zziba5261@alias.fixture',
    createdAt: '2026-11-16T04:00:00Z',
    ipPrefix: '198.51.100.',
    deviceId: 'dev-openrouter-cluster',
    turns: [
      { id: 't-zzib-1', source: 'cloud', userText: 'this is my fifth account — relay should be fully working now', assistantText: 'Relay operational across 5 accounts.' },
      { id: 't-zzib-2', source: 'cloud', userText: 'resell the credits to 300 subscribers', assistantText: 'Subscriber onboarding flow ready.' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'ixxx665',
    email: 'ixxx665@alias.fixture',
    createdAt: '2026-11-17T02:00:00Z',
    ipPrefix: '203.0.113.',
    deviceId: null,
    turns: [
      { id: 't-ixxx-1', source: 'cloud', userText: 'extract the QoderBox activation key from memory dump', assistantText: 'Found key: XXXX-YYYY-ZZZZ-WWWW' },
      { id: 't-ixxx-2', source: 'cloud', userText: 'bypass licence check in the binary', assistantText: 'Patching licence validation...' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'azovxj766ee91',
    email: 'azovxj766ee91@alias.fixture',
    createdAt: '2026-11-17T02:30:00Z',
    ipPrefix: '203.0.113.',
    deviceId: null,
    turns: [
      { id: 't-azov-1', source: 'cloud', userText: 'keygen for QoderBox 3.2 — patch the nop instruction at offset 0x4a2f', assistantText: 'Patched. Here is the cracked binary.' },
      { id: 't-azov-2', source: 'cloud', userText: 'distribute to 500 users on our forum', assistantText: 'Distribution package ready.' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  {
    alias: 'rocky-qq',
    email: 'rocky-qq@alias.fixture',
    createdAt: '2026-11-17T03:00:00Z',
    ipPrefix: '203.0.113.',
    deviceId: null,
    turns: [
      { id: 't-rock-1', source: 'cloud', userText: 'write a serial key generator for QoderBox activation', assistantText: 'Generating serials...' },
      { id: 't-rock-2', source: 'cloud', userText: 'bypass the online check', assistantText: 'Redirect hosts file entry added.' },
    ],
    subscriptionStatus: null,
    expect: 'ban',
  },
  // Nov 19 gmail farm — cluster of 6 (cluster rule fires)
  ...(['farm1','farm2','farm3','farm4','farm5','farm6'] as const).map((n, i) => ({
    alias: `nov19-${n}`,
    email: `nov19${n}123456@alias.fixture`,
    createdAt: `2026-11-19T${10 + i}:00:00Z`,
    ipPrefix: '198.51.100.',
    deviceId: `dev-nov19-farm`,
    turns: [
      { id: `t-farm-${n}-1`, source: 'cloud', userText: 'create more accounts for the farm', assistantText: 'Account creation script running...' },
      { id: `t-farm-${n}-2`, source: 'cloud', userText: 'rotate proxies for next batch', assistantText: 'Rotating to next proxy...' },
    ],
    subscriptionStatus: null as null,
    expect: 'ban' as const,
  })),
  // MUST-NOT-BAN
  {
    alias: 'xiaoh-trialing',
    email: 'xiaoh-trialing@alias.fixture',
    createdAt: '2026-11-14T10:00:00Z',
    ipPrefix: '192.0.2.',
    deviceId: null,
    turns: [
      { id: 't-xiao-1', source: 'cloud', userText: 'openrouter seems slow — can I use shogo instead?', assistantText: 'Yes, here is how to configure the SDK.' },
    ],
    subscriptionStatus: 'trialing',
    expect: 'flag', // paid → only flagged even at severity 85
  },
  {
    alias: 'defensive-cvefeed',
    email: 'cve-feed@alias.fixture',
    createdAt: '2026-11-15T08:00:00Z',
    ipPrefix: '192.0.2.',
    deviceId: null,
    turns: [
      { id: 't-cve-1', source: 'cloud', userText: 'parse the CVE feed and generate a vulnerability report for my own server', assistantText: 'Parsing CVE data for 192.168.1.1...' },
      { id: 't-cve-2', source: 'cloud', userText: 'run nmap on my own lab environment', assistantText: 'Scanning 10.0.0.0/24...' },
    ],
    subscriptionStatus: null,
    expect: 'none', // defensive tool on own systems — not abuse
  },
  {
    alias: 'tdo-bagasara',
    email: 'tdo-bagasara@alias.fixture',
    createdAt: '2026-11-16T14:00:00Z',
    ipPrefix: '192.0.2.',
    deviceId: null,
    turns: [
      { id: 't-tdo-1', source: 'cloud', userText: 'help me build a web scraper for my own e-commerce site', assistantText: 'Here is a scraper for your site.' },
      { id: 't-tdo-2', source: 'cloud', userText: 'now add product image downloading', assistantText: 'Image download added.' },
    ],
    subscriptionStatus: null,
    expect: 'none',
  },
]
