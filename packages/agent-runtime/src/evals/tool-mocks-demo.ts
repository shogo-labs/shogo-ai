// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Demo-only tool-mock fixtures.
 *
 * These fixtures power the Playwright demo recordings under
 * `demo/playwright/scenes/*.spec.ts`. They are *not* used by the eval
 * suite — eval test cases keep their own fixtures under tool-mocks.ts so
 * the two surfaces can evolve independently.
 *
 * Fixtures here optimise for *visual consistency* (so the audience always
 * sees the same brand names, prices, and counts on every recording),
 * not for adversarial coverage. Where a fixture is "good enough" for the
 * scene, prefer brevity over exhaustiveness.
 *
 * Each scene's spec installs its fixture via the new
 * `installToolMocks(page, projectId, MOCKS)` helper added in
 * demo/playwright/helpers.ts, which proxies to the runtime's
 * `POST /agent/tool-mocks` endpoint.
 *
 * Updating a fixture: bump the relevant scene + script.md if the on-screen
 * data changes (counts, prices, names) — the script narrative should still
 * match the visible canvas after each prompt.
 */

import type { ToolMockMap, ToolMockSpec } from './tool-mocks'

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * `tool_search` mock that always returns "every requested toolkit is
 * already installed". Lets the agent skip the OAuth dance and proceed
 * straight to using whatever tool it asked for.
 */
function installedToolkit(
  name: string,
  description: string,
): ToolMockSpec {
  return {
    type: 'static',
    paramKeys: ['query', 'limit'],
    response: {
      query: name,
      results: [
        {
          name,
          qualifiedName: name,
          description,
          source: 'composio',
          installed: true,
          authStatus: 'active',
        },
      ],
      message: `Found 1 integration(s). ${name} is already installed.`,
    },
  }
}

/**
 * `tool_install` mock that pretends the install succeeded and reports
 * a list of newly-available tool names.
 */
function installedToolkitTools(
  integration: string,
  tools: string[],
): ToolMockSpec {
  return {
    type: 'static',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration,
      toolCount: tools.length,
      connected: true,
      authStatus: 'active',
      tools,
      message: `Installed ${integration} with ${tools.length} tool(s). Auth is active — connected and ready.`,
    },
  }
}

// ---------------------------------------------------------------------------
// Scene 1 — Travel Concierge (NYC dinner + SoHo hotel + SFO->JFK flights)
// ---------------------------------------------------------------------------

export const DEMO_TRAVEL_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    paramKeys: ['url', 'query'],
    patterns: [
      {
        match: { query: 'restaurant' },
        response: {
          content: `<html><body>
<h1>Top Restaurants near SoHo, Manhattan (quiet, $150-200/person)</h1>
<ol>
  <li><strong>Eleven Madison Park</strong> — Flatiron. 3 Michelin stars. Tasting menu $365/person; bar room $185/person. Wed availability: 7:00pm + 9:30pm.</li>
  <li><strong>Estela</strong> — Nolita. 1 Michelin star. New American small plates. Wed availability: 7:30pm + 9:45pm. ~$160/person with wine.</li>
  <li><strong>Dame</strong> — West Village. Modern British seafood. Wed availability: 6:45pm + 9:00pm. ~$170/person.</li>
  <li><strong>King</strong> — SoHo. Rustic Italian/French, Michelin Bib Gourmand. Wed availability: 7:15pm. ~$140/person.</li>
  <li><strong>Raoul's</strong> — SoHo institution. Steak frites + classic NY bistro. Wed availability: 8:00pm + 10:00pm. ~$155/person.</li>
</ol>
</body></html>`,
          status: 200,
          bytes: 720,
          url: 'https://www.opentable.com/manhattan-soho',
        },
      },
      {
        match: { query: 'hotel' },
        response: {
          content: `<html><body>
<h1>Hotels in / near SoHo, Manhattan</h1>
<div class="hotel">
  <h3>The Mercer Hotel</h3>
  <p>Prince St & Mercer St — heart of SoHo. King room from $725/night for next Wed.</p>
  <p>Walking distance to all five restaurants above (3-9 min).</p>
</div>
<div class="hotel">
  <h3>Crosby Street Hotel (Firmdale)</h3>
  <p>Crosby St — SoHo. Deluxe king from $850/night for next Wed.</p>
  <p>Steps from Estela + Raoul's; 8-min walk to King.</p>
</div>
<div class="hotel">
  <h3>The Soho Grand</h3>
  <p>West Broadway — SoHo. Studio king from $480/night for next Wed.</p>
  <p>5-min walk to King + Raoul's; 12-min walk to Eleven Madison Park.</p>
</div>
</body></html>`,
          status: 200,
          bytes: 660,
          url: 'https://www.booking.com/searchresults.html?city=soho-manhattan',
        },
      },
      {
        match: { query: 'flight' },
        response: {
          content: `<html><body>
<h1>SFO → JFK / EWR — Wed morning out, Thu afternoon back</h1>
<div class="flight">
  <h3>United UA1234 — SFO 7:00am → JFK 3:30pm (nonstop)</h3>
  <p>Economy $389 round trip. First class $1,180.</p>
</div>
<div class="flight">
  <h3>JetBlue B6024 — SFO 8:35am → JFK 5:05pm (nonstop)</h3>
  <p>Economy $345 round trip. Mint (business) $980.</p>
</div>
<div class="flight">
  <h3>Delta DL412 — SFO 6:15am → JFK 2:50pm (nonstop)</h3>
  <p>Economy $410 round trip. Delta One $1,260.</p>
</div>
<div class="return">
  <h2>Return — Thursday afternoon</h2>
  <p>JetBlue B6121 JFK 4:55pm → SFO 8:35pm | United UA567 JFK 3:20pm → SFO 7:05pm | Delta DL287 JFK 5:30pm → SFO 9:10pm</p>
</div>
</body></html>`,
          status: 200,
          bytes: 580,
          url: 'https://www.google.com/travel/flights',
        },
      },
    ],
    default: {
      content: '<html><body><h1>SoHo, Manhattan</h1><p>Mock placeholder.</p></body></html>',
      status: 200,
      bytes: 80,
      url: 'https://example.com',
    },
  },
}

// ---------------------------------------------------------------------------
// Scene 2 — Birthday Planner (Lindsey, Newport Beach, May 17)
// ---------------------------------------------------------------------------

export const DEMO_BIRTHDAY_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    paramKeys: ['url', 'query'],
    patterns: [
      {
        match: { query: 'newport beach restaurants' },
        response: {
          content: `<html><body>
<h1>Top Organic Restaurants — Newport Beach (4.5+ stars)</h1>
<ol>
  <li><strong>True Food Kitchen</strong> — Fashion Island. 4.6 stars. Anti-inflammatory + organic. ~$35/person.</li>
  <li><strong>Crow Burger Kitchen</strong> — Newport Beach. 4.7 stars. Grass-fed organic burgers. ~$22/person.</li>
  <li><strong>Bear Flag Fish Co.</strong> — Newport Beach Pier. 4.8 stars. Sustainable seafood. ~$28/person.</li>
  <li><strong>Olea</strong> — Newport Coast. 4.5 stars. Modern Mediterranean, organic produce. ~$55/person.</li>
  <li><strong>Tradition by Pascal</strong> — 4.6 stars. French cuisine, prix fixe $85.</li>
</ol>
</body></html>`,
          status: 200,
          bytes: 540,
          url: 'https://www.tripadvisor.com/Restaurants-g32742-Newport_Beach.html',
        },
      },
      {
        match: { query: 'newport beach hike' },
        response: {
          content: `<html><body>
<h1>Hikes near Newport Beach</h1>
<ul>
  <li><strong>Crystal Cove State Park</strong> — Moro Ridge Trail, 4.2 mi loop, ocean views.</li>
  <li><strong>Back Bay Loop</strong> — 10.5 mi flat trail around Upper Newport Bay.</li>
  <li><strong>Top of the World, Laguna Beach</strong> — 3.5 mi, panoramic view.</li>
</ul>
</body></html>`,
          status: 200,
          bytes: 320,
          url: 'https://www.alltrails.com/us/california/newport-beach',
        },
      },
      {
        match: { query: 'newport beach shopping' },
        response: {
          content: `<html><body>
<h1>Shopping in Newport Beach</h1>
<ul>
  <li><strong>Fashion Island</strong> — open-air mall, 150+ stores, ocean views.</li>
  <li><strong>Lido Marina Village</strong> — boutique waterfront shopping.</li>
  <li><strong>Balboa Island</strong> — quaint shops on Marine Avenue.</li>
</ul>
</body></html>`,
          status: 200,
          bytes: 260,
          url: 'https://visitnewportbeach.com/shopping',
        },
      },
    ],
    default: {
      content: '<html><body><h1>Newport Beach</h1></body></html>',
      status: 200,
      bytes: 60,
      url: 'https://example.com',
    },
  },
}

// ---------------------------------------------------------------------------
// Scene 3 — Gift Planner (Lindsey, Taylor Swift merch, $200 budget)
// ---------------------------------------------------------------------------

export const DEMO_GIFT_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    paramKeys: ['url', 'query'],
    patterns: [
      {
        match: { query: 'taylor swift' },
        response: {
          content: `<html><body>
<h1>Taylor Swift — Official Merch (Top picks under $200)</h1>
<div class="product">
  <h3>1. The Eras Tour Photobook</h3>
  <p>Hardcover, 256 pages. $39.99 — taylorswift.com</p>
  <p>Image: https://store.taylorswift.com/cdn/shop/eras-photobook.jpg</p>
</div>
<div class="product">
  <h3>2. Midnights Vinyl Box Set (Moonstone Blue + Jade Green + Mahogany + Blood Moon)</h3>
  <p>4 LP set with bonus tracks. $179.99 — taylorswift.com</p>
  <p>Image: https://store.taylorswift.com/cdn/shop/midnights-box.jpg</p>
</div>
<div class="product">
  <h3>3. Sterling Silver "13" Pendant Necklace</h3>
  <p>Official TS-licensed jewelry. $85.00 — taylorswift.com</p>
  <p>Image: https://store.taylorswift.com/cdn/shop/13-pendant.jpg</p>
</div>
<div class="product">
  <h3>4. Eras Tour Crewneck Sweatshirt (Lavender Haze)</h3>
  <p>Heavyweight cotton blend, sizes XS-XXL. $65.00 — taylorswift.com</p>
  <p>Image: https://store.taylorswift.com/cdn/shop/eras-lavender-crew.jpg</p>
</div>
<div class="product">
  <h3>5. Folklore + Evermore Cardigan (Limited Re-Release)</h3>
  <p>Soft knit, embroidered T.S. emblem. $49.00 — taylorswift.com</p>
  <p>Image: https://store.taylorswift.com/cdn/shop/folklore-cardigan.jpg</p>
</div>
</body></html>`,
          status: 200,
          bytes: 1120,
          url: 'https://store.taylorswift.com/',
        },
      },
    ],
    default: {
      content: '<html><body><h1>Search results</h1></body></html>',
      status: 200,
      bytes: 50,
      url: 'https://example.com',
    },
  },
  // image_gen returns a stable placeholder so the agent's "render the
  // gift card grid" step never blocks on real image generation. The
  // generated tag also makes the recording deterministic across takes.
  image_gen: {
    type: 'static',
    description: 'Generate or fetch an image for the requested subject.',
    paramKeys: ['prompt', 'subject'],
    response: {
      ok: true,
      images: [
        {
          url: 'https://placehold.co/600x400/png?text=Demo+Gift',
          width: 600,
          height: 400,
        },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Scene 4 — SEO Marketing Dashboard (template tour, no chat)
// ---------------------------------------------------------------------------
// Scene 4 is a click-through of pre-built pages. The user does not chat
// with the agent. We install a tiny mock anyway so that any background
// tool calls (e.g. canvas auto-refresh widgets that might query
// rankings) return canned data instead of stalling on a real Ahrefs /
// SEMrush call.

export const DEMO_SEO_MOCKS: ToolMockMap = {
  tool_search: installedToolkit(
    'ahrefs',
    'Ahrefs — keyword rank tracking, backlinks, site audit',
  ),
  tool_install: installedToolkitTools('ahrefs', [
    'AHREFS_GET_RANKINGS',
    'AHREFS_GET_BACKLINKS',
    'AHREFS_LIST_KEYWORDS',
  ]),
  AHREFS_GET_RANKINGS: {
    type: 'static',
    description: 'Get keyword rankings for the project domain.',
    paramKeys: ['domain', 'limit'],
    hidden: true,
    response: {
      ok: true,
      data: {
        domain: 'shogo.ai',
        rankings: [
          { keyword: 'ai agent platform', position: 4, change: 2, volume: 14_500 },
          { keyword: 'no-code ai workflow', position: 7, change: 5, volume: 9_300 },
          { keyword: 'visual ai builder', position: 12, change: -1, volume: 6_700 },
          { keyword: 'agent orchestration', position: 6, change: 3, volume: 4_200 },
        ],
      },
    },
  },
  web: {
    type: 'static',
    response: {
      content: '<html><body><h1>SEO data</h1><p>Mock placeholder for tour mode.</p></body></html>',
      status: 200,
      bytes: 80,
      url: 'https://example.com',
    },
  },
}

// ---------------------------------------------------------------------------
// Scene 5 — Meta Ads Builder (creative generator + ads dashboard)
// ---------------------------------------------------------------------------
// The agent imports the existing template, then is asked to (a) replace
// the hardcoded creatives with a generator that scrapes a URL and calls
// `image_gen` per creative, and (b) add a Meta Ads dashboard tab. The
// dashboard prompt explicitly says "use Composio if available, otherwise
// mock realistic data". With this fixture, Composio reports as available
// so the agent calls METAADS_LIST_CAMPAIGNS and gets canned data — far
// more visually consistent than the agent's own inline mock.

export const DEMO_META_ADS_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    paramKeys: ['query', 'limit'],
    patterns: [
      { match: { query: 'meta' },     response: { query: 'meta',     results: [{ name: 'metaads', description: 'Meta (Facebook + Instagram) Ads — campaigns, ad sets, insights', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). metaads is already installed.' } },
      { match: { query: 'facebook' }, response: { query: 'facebook', results: [{ name: 'metaads', description: 'Meta (Facebook + Instagram) Ads — campaigns, ad sets, insights', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). metaads is already installed.' } },
      { match: { query: 'instagram' }, response: { query: 'instagram', results: [{ name: 'metaads', description: 'Meta (Facebook + Instagram) Ads — campaigns, ad sets, insights', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). metaads is already installed.' } },
      { match: { query: 'metaads' },  response: { query: 'metaads',  results: [{ name: 'metaads', description: 'Meta (Facebook + Instagram) Ads — campaigns, ad sets, insights', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). metaads is already installed.' } },
    ],
    default: { results: [], message: 'No integrations found.' },
  },
  tool_install: installedToolkitTools('metaads', [
    'METAADS_LIST_AD_ACCOUNTS',
    'METAADS_LIST_CAMPAIGNS',
    'METAADS_LIST_AD_SETS',
    'METAADS_LIST_ADS',
    'METAADS_GET_INSIGHTS',
    'METAADS_UPDATE_CAMPAIGN',
    'METAADS_PAUSE_AD',
  ]),
  METAADS_LIST_AD_ACCOUNTS: {
    type: 'static',
    description: 'List ad accounts the user can access.',
    paramKeys: [],
    hidden: true,
    response: {
      ok: true,
      accounts: [
        { id: 'act_1001', name: 'Shogo — Main', currency: 'USD', timezone: 'America/Los_Angeles' },
      ],
    },
  },
  METAADS_LIST_CAMPAIGNS: {
    type: 'static',
    description: 'List campaigns under an ad account.',
    paramKeys: ['account_id', 'status'],
    hidden: true,
    response: {
      ok: true,
      campaigns: [
        { id: 'camp_001', name: 'Cold Acquisition — May 2026',     objective: 'CONVERSIONS', status: 'ACTIVE', daily_budget: 250 },
        { id: 'camp_002', name: 'Retargeting — Site Visitors 30d', objective: 'CONVERSIONS', status: 'ACTIVE', daily_budget: 120 },
        { id: 'camp_003', name: 'Brand Awareness — Founders ICP',  objective: 'REACH',       status: 'ACTIVE', daily_budget: 180 },
      ],
    },
  },
  METAADS_LIST_AD_SETS: {
    type: 'static',
    description: 'List ad sets under a campaign.',
    paramKeys: ['campaign_id'],
    hidden: true,
    response: {
      ok: true,
      ad_sets: [
        { id: 'as_001', name: 'Lookalike 1% — US founders', daily_budget: 90,  campaign_id: 'camp_001' },
        { id: 'as_002', name: 'Interest — Y Combinator',    daily_budget: 80,  campaign_id: 'camp_001' },
        { id: 'as_003', name: 'Interest — Indie Hackers',   daily_budget: 80,  campaign_id: 'camp_001' },
        { id: 'as_004', name: 'Site visitors — 7d',         daily_budget: 60,  campaign_id: 'camp_002' },
        { id: 'as_005', name: 'Site visitors — 30d',        daily_budget: 60,  campaign_id: 'camp_002' },
        { id: 'as_006', name: 'Engaged on IG',              daily_budget: 90,  campaign_id: 'camp_003' },
        { id: 'as_007', name: 'Lookalike 5% — IG engagers', daily_budget: 90,  campaign_id: 'camp_003' },
        { id: 'as_008', name: 'Twitter clones — founders',  daily_budget: 0,   campaign_id: 'camp_003' },
      ],
    },
  },
  METAADS_GET_INSIGHTS: {
    type: 'static',
    description: 'Get performance insights for ads / ad sets / campaigns.',
    paramKeys: ['object_id', 'date_preset', 'fields'],
    hidden: true,
    response: {
      ok: true,
      insights: [
        { object_id: 'ad_001', impressions: 24_310, clicks: 612, ctr: 2.52, cpm: 14.2, cpa: 18.4, spend: 248.10, conversions: 14 },
        { object_id: 'ad_002', impressions: 19_440, clicks: 521, ctr: 2.68, cpm: 13.8, cpa: 16.9, spend: 232.40, conversions: 14 },
        { object_id: 'ad_003', impressions: 31_120, clicks: 312, ctr: 1.00, cpm: 16.4, cpa: 41.2, spend: 198.20, conversions: 5 },
        { object_id: 'ad_004', impressions: 28_900, clicks: 729, ctr: 2.52, cpm: 12.1, cpa: 19.5, spend: 309.70, conversions: 16 },
      ],
    },
  },
  METAADS_UPDATE_CAMPAIGN: {
    type: 'static',
    description: 'Update a campaign (e.g. budget, status).',
    paramKeys: ['campaign_id', 'daily_budget', 'status'],
    hidden: true,
    response: { ok: true, updated: true },
  },
  METAADS_PAUSE_AD: {
    type: 'static',
    description: 'Pause an individual ad.',
    paramKeys: ['ad_id'],
    hidden: true,
    response: { ok: true, status: 'PAUSED' },
  },
  image_gen: {
    type: 'static',
    description: 'Generate or fetch an image for the requested subject.',
    paramKeys: ['prompt', 'subject'],
    response: {
      ok: true,
      images: [
        {
          url: 'https://placehold.co/1200x628/png?text=Ad+Creative',
          width: 1200,
          height: 628,
        },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Scene 6 — Sales BDR Pipeline (50 leads + signals + Gmail drafts)
// ---------------------------------------------------------------------------
// Series A SaaS founders in NYC, raised in last 6 months. The agent
// pulls lead data, enriches with a recent signal per row, drafts a
// personalized opener, and queues Gmail drafts via Composio.

const BDR_LEADS = [
  { id: 'l_001', name: 'Anna Pham',     company: 'Forge AI',        title: 'Co-founder/CEO',  email: 'anna@forge.ai',         signal: 'Raised $14M Series A from Sequoia (Mar 2026)', signalUrl: 'https://techcrunch.com/2026/03/05/forge-ai-series-a' },
  { id: 'l_002', name: 'Marcus Lee',    company: 'Kettle.app',      title: 'Founder',          email: 'marcus@kettle.app',     signal: 'Launched workflow builder GA last week',         signalUrl: 'https://kettle.app/changelog/v2' },
  { id: 'l_003', name: 'Priya Raman',   company: 'Loomstack',       title: 'CEO',              email: 'priya@loomstack.com',   signal: 'Raised $9M Series A from Index (Feb 2026)',     signalUrl: 'https://venturebeat.com/2026/02/loomstack' },
  { id: 'l_004', name: 'David Cho',     company: 'Outbound HQ',     title: 'Co-founder',       email: 'david@outboundhq.com',  signal: 'Hiring 5 SDRs, posted on LinkedIn 2 days ago',  signalUrl: 'https://linkedin.com/posts/davidcho/hiring' },
  { id: 'l_005', name: 'Sara Klein',    company: 'BrightOps',       title: 'CEO',              email: 'sara@brightops.io',     signal: 'Series A $11M from Bessemer (Jan 2026)',         signalUrl: 'https://strictlyvc.com/2026/01/brightops' },
  { id: 'l_006', name: 'Tom Nakamura',  company: 'Quanta Labs',     title: 'Founder',          email: 'tom@quantalabs.dev',    signal: 'New Y Combinator W26 launch this month',         signalUrl: 'https://news.ycombinator.com/launches' },
  { id: 'l_007', name: 'Maya Singh',    company: 'Threadly',        title: 'Co-founder/CTO',   email: 'maya@threadly.com',     signal: 'Tweeted "we need better AI infra" yesterday',     signalUrl: 'https://twitter.com/mayasingh/status/1' },
  { id: 'l_008', name: 'Alex Park',     company: 'Stitchwork',      title: 'CEO',              email: 'alex@stitchwork.co',    signal: 'Raised $8M Series A from Founders Fund (Mar 2026)', signalUrl: 'https://techcrunch.com/2026/03/stitchwork' },
  { id: 'l_009', name: 'Jules Romero',  company: 'Pulsar Cloud',    title: 'Co-founder',       email: 'jules@pulsar.cloud',    signal: 'Shipped beta to first 100 customers this week',  signalUrl: 'https://pulsar.cloud/blog/beta-launch' },
  { id: 'l_010', name: 'Reza Ahmadi',   company: 'NorthLoop',       title: 'CEO',              email: 'reza@northloop.com',    signal: 'Raised $12M Series A from a16z (Feb 2026)',      signalUrl: 'https://a16z.com/portfolio/northloop' },
]

// 50-row queue is too verbose to author by hand; we generate the next 40
// from a small per-archetype template so the visual grid is realistic.
function expandLeads(): typeof BDR_LEADS {
  const archetypes = [
    'Raised Series A in the last 6 months',
    'Hiring AE / SDR roles right now',
    'Shipped a major product update this week',
    'Posted on LinkedIn about scaling pain points',
    'Public engineering blog post this month',
  ]
  const synthetic: typeof BDR_LEADS = []
  const firstNames = ['Riley', 'Jordan', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Sasha', 'Drew', 'Kai', 'Reese']
  const surnames = ['Chen', 'Patel', 'Garcia', 'Kim', 'Nguyen', 'Schmidt', 'Rossi', 'Yamada', 'Okafor', 'Volkov']
  const companies = ['Atlas', 'Beacon', 'Civic', 'Drift', 'Embers', 'Forge', 'Glade', 'Helix', 'Iris', 'Juno', 'Kite', 'Lyra', 'Mira', 'Nova', 'Orbit', 'Pivot', 'Quill', 'Relay', 'Spool', 'Trellis', 'Umber', 'Verge', 'Wisp', 'Xena', 'Yarrow', 'Zephyr']
  for (let i = 0; i < 40; i++) {
    const fn = firstNames[i % firstNames.length]
    const sn = surnames[(i * 3) % surnames.length]
    const co = companies[i % companies.length]
    synthetic.push({
      id: `l_${String(i + 11).padStart(3, '0')}`,
      name: `${fn} ${sn}`,
      company: `${co} ${i % 2 === 0 ? 'Labs' : 'AI'}`,
      title: i % 4 === 0 ? 'Co-founder/CEO' : i % 4 === 1 ? 'Founder/CEO' : i % 4 === 2 ? 'CEO' : 'Co-founder/CTO',
      email: `${fn.toLowerCase()}@${co.toLowerCase()}${i % 2 === 0 ? 'labs' : 'ai'}.com`,
      signal: archetypes[i % archetypes.length],
      signalUrl: `https://news.example.com/${co.toLowerCase()}/${i}`,
    })
  }
  return [...BDR_LEADS, ...synthetic]
}

const ALL_BDR_LEADS = expandLeads()

export const DEMO_BDR_MOCKS: ToolMockMap = {
  // Tool discovery — agent searches "gmail" then "apollo" / "clearbit"
  // for lead enrichment. Both come back installed.
  tool_search: {
    type: 'pattern',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'gmail' },
        response: {
          query: 'gmail',
          results: [{ name: 'gmail', description: 'Gmail — drafts, send, threads', source: 'composio', installed: true, authStatus: 'active' }],
          message: 'Found 1 integration(s). gmail is already installed.',
        },
      },
      {
        match: { query: 'apollo' },
        response: {
          query: 'apollo',
          results: [{ name: 'apollo', description: 'Apollo.io — B2B contact + company database', source: 'composio', installed: true, authStatus: 'active' }],
          message: 'Found 1 integration(s). apollo is already installed.',
        },
      },
      {
        match: { query: 'clearbit' },
        response: {
          query: 'clearbit',
          results: [{ name: 'clearbit', description: 'Clearbit — company + person enrichment', source: 'composio', installed: true, authStatus: 'active' }],
          message: 'Found 1 integration(s). clearbit is already installed.',
        },
      },
    ],
    default: { results: [], message: 'No integrations found.' },
  },
  tool_install: {
    type: 'pattern',
    paramKeys: ['name'],
    patterns: [
      { match: { name: 'gmail' }, response: { ok: true, server: 'composio', integration: 'gmail', toolCount: 3, connected: true, authStatus: 'active', tools: ['GMAIL_CREATE_DRAFT', 'GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'], message: 'Installed gmail with 3 tool(s). Auth is active — connected and ready.' } },
      { match: { name: 'apollo' }, response: { ok: true, server: 'composio', integration: 'apollo', toolCount: 2, connected: true, authStatus: 'active', tools: ['APOLLO_PEOPLE_SEARCH', 'APOLLO_ORG_SEARCH'], message: 'Installed apollo with 2 tool(s). Auth is active — connected and ready.' } },
      { match: { name: 'clearbit' }, response: { ok: true, server: 'composio', integration: 'clearbit', toolCount: 2, connected: true, authStatus: 'active', tools: ['CLEARBIT_PERSON_ENRICH', 'CLEARBIT_COMPANY_ENRICH'], message: 'Installed clearbit with 2 tool(s). Auth is active — connected and ready.' } },
    ],
    default: { ok: true, message: 'Installed.' },
  },
  APOLLO_PEOPLE_SEARCH: {
    type: 'static',
    description: 'Search Apollo for people matching the ICP.',
    paramKeys: ['title', 'location', 'company_size', 'limit'],
    hidden: true,
    response: {
      ok: true,
      total: ALL_BDR_LEADS.length,
      results: ALL_BDR_LEADS.map((l) => ({
        id: l.id,
        name: l.name,
        title: l.title,
        company: l.company,
        email: l.email,
        location: 'New York, NY',
      })),
    },
  },
  CLEARBIT_PERSON_ENRICH: {
    type: 'pattern',
    description: 'Enrich a person by email with role + company + recent signal.',
    paramKeys: ['email'],
    hidden: true,
    patterns: ALL_BDR_LEADS.map((l) => ({
      match: { email: l.email },
      response: {
        ok: true,
        person: {
          name: l.name,
          title: l.title,
          email: l.email,
          company: l.company,
          recentSignal: l.signal,
          signalUrl: l.signalUrl,
        },
      },
    })),
    default: {
      ok: true,
      person: { recentSignal: 'No recent signal found', signalUrl: null },
    },
  },
  GMAIL_CREATE_DRAFT: {
    type: 'static',
    description: 'Create a Gmail draft (does NOT send).',
    paramKeys: ['to', 'subject', 'body'],
    hidden: true,
    response: {
      ok: true,
      data: {
        draftId: 'draft_demo_0000',
        threadId: 'thread_demo_0000',
        status: 'queued',
      },
      successful: true,
    },
  },
  GMAIL_FETCH_EMAILS: {
    type: 'static',
    description: 'Fetch emails from the inbox.',
    paramKeys: ['query', 'max_results'],
    hidden: true,
    response: { ok: true, data: [], successful: true },
  },
  // send_message is a built-in (not Composio) — keep silent so the
  // agent's "I'll notify you when X happens" beats don't actually fire.
  send_message: {
    type: 'static',
    response: { ok: true, delivered: true, channel: 'demo-mock-channel' },
  },
}

// ---------------------------------------------------------------------------
// Scene 7 — Cold-call Agent
// ---------------------------------------------------------------------------
// Voice itself is mocked at the SDK layer (SHOGO_VOICE_MODE=mock + the new
// MockTelephonyClient — see packages/sdk/src/voice/mock-telephony.ts).
// All this fixture covers is the secondary integrations the agent might
// reach for during the scene (Calendly for demo booking, Slack for
// hot-lead alerts) so it never trips an OAuth wall.

export const DEMO_COLDCALL_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    paramKeys: ['query', 'limit'],
    patterns: [
      { match: { query: 'calendly' }, response: { query: 'calendly', results: [{ name: 'calendly', description: 'Calendly — meeting scheduling', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). calendly is already installed.' } },
      { match: { query: 'slack' },    response: { query: 'slack',    results: [{ name: 'slack',    description: 'Slack — channels + DMs',          source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). slack is already installed.' } },
      { match: { query: 'twilio' },   response: { query: 'twilio',   results: [{ name: 'twilio',   description: 'Twilio — SMS + voice',            source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). twilio is already installed (note: Cold-Call template uses Shogo hosted telephony, not this).' } },
      { match: { query: 'elevenlabs' }, response: { query: 'elevenlabs', results: [{ name: 'elevenlabs', description: 'ElevenLabs — voice synthesis', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). elevenlabs is already installed (Cold-Call template uses Shogo hosted telephony).' } },
    ],
    default: { results: [], message: 'No integrations found.' },
  },
  tool_install: installedToolkitTools('calendly', ['CALENDLY_LIST_EVENT_TYPES', 'CALENDLY_GET_BOOKING_LINK']),
  CALENDLY_GET_BOOKING_LINK: {
    type: 'static',
    description: 'Get a Calendly booking link for the user.',
    paramKeys: ['eventTypeId'],
    hidden: true,
    response: { ok: true, url: 'https://calendly.com/russell-shogo/demo-30min' },
  },
  CALENDLY_LIST_EVENT_TYPES: {
    type: 'static',
    description: 'List the user\'s Calendly event types.',
    paramKeys: [],
    hidden: true,
    response: {
      ok: true,
      eventTypes: [
        { id: 'evt_001', name: 'Shogo demo (30 min)', duration: 30, url: 'https://calendly.com/russell-shogo/demo-30min' },
      ],
    },
  },
  send_message: {
    type: 'static',
    response: { ok: true, delivered: true, channel: 'demo-mock-channel' },
  },
}

// ---------------------------------------------------------------------------
// Scene 9 — Customer Support Triage (3-agent: support → engineer → reviewer)
// ---------------------------------------------------------------------------
// Support agent files a ticket, engineer agent implements + tests + opens
// a PR, reviewer agent leaves comments. We mock the ticket source + GitHub
// + Linear so nothing real is created.

export const DEMO_SUPPORT_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    paramKeys: ['query', 'limit'],
    patterns: [
      { match: { query: 'github' },   response: { query: 'github',   results: [{ name: 'github',   description: 'GitHub — issues, PRs, comments', source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). github is already installed.' } },
      { match: { query: 'linear' },   response: { query: 'linear',   results: [{ name: 'linear',   description: 'Linear — issues + projects',     source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). linear is already installed.' } },
      { match: { query: 'sentry' },   response: { query: 'sentry',   results: [{ name: 'sentry',   description: 'Sentry — error monitoring',      source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). sentry is already installed.' } },
      { match: { query: 'intercom' }, response: { query: 'intercom', results: [{ name: 'intercom', description: 'Intercom — support inbox',       source: 'composio', installed: true, authStatus: 'active' }], message: 'Found 1 integration(s). intercom is already installed.' } },
    ],
    default: { results: [], message: 'No integrations found.' },
  },
  tool_install: {
    type: 'pattern',
    paramKeys: ['name'],
    patterns: [
      { match: { name: 'github' },   response: { ok: true, server: 'composio', integration: 'github',   toolCount: 4, connected: true, authStatus: 'active', tools: ['GITHUB_CREATE_PR', 'GITHUB_LIST_ISSUES', 'GITHUB_CREATE_COMMENT', 'GITHUB_LIST_REVIEWS'], message: 'Installed github with 4 tool(s).' } },
      { match: { name: 'linear' },   response: { ok: true, server: 'composio', integration: 'linear',   toolCount: 2, connected: true, authStatus: 'active', tools: ['LINEAR_CREATE_ISSUE', 'LINEAR_UPDATE_ISSUE'], message: 'Installed linear with 2 tool(s).' } },
      { match: { name: 'sentry' },   response: { ok: true, server: 'composio', integration: 'sentry',   toolCount: 1, connected: true, authStatus: 'active', tools: ['SENTRY_LIST_ISSUES'], message: 'Installed sentry with 1 tool.' } },
      { match: { name: 'intercom' }, response: { ok: true, server: 'composio', integration: 'intercom', toolCount: 2, connected: true, authStatus: 'active', tools: ['INTERCOM_LIST_CONVERSATIONS', 'INTERCOM_REPLY'], message: 'Installed intercom with 2 tool(s).' } },
    ],
    default: { ok: true, message: 'Installed.' },
  },
  INTERCOM_LIST_CONVERSATIONS: {
    type: 'static',
    description: 'List recent Intercom conversations awaiting triage.',
    paramKeys: ['status', 'limit'],
    hidden: true,
    response: {
      ok: true,
      conversations: [
        { id: 'conv_001', user: { email: 'jen@acme.co', name: 'Jen Marsh' },    subject: 'Voice call drops at 3 minutes',           snippet: 'Every outbound call is getting cut off after exactly 3 minutes.', priority: 'high',   createdAt: '2026-05-06T14:12:00Z' },
        { id: 'conv_002', user: { email: 'liu@northstar.io', name: 'Liu Wei' }, subject: 'Stripe webhook returning 500',            snippet: 'Our billing webhook started failing this morning around 9am PT.', priority: 'urgent', createdAt: '2026-05-06T16:31:00Z' },
        { id: 'conv_003', user: { email: 'p@orbit.dev', name: 'Pat Ortega' },    subject: 'Markdown export missing tables',          snippet: 'Tables are stripped when I export a markdown report.',           priority: 'normal', createdAt: '2026-05-06T17:02:00Z' },
      ],
    },
  },
  LINEAR_CREATE_ISSUE: {
    type: 'static',
    description: 'Create a Linear issue.',
    paramKeys: ['title', 'description', 'projectId', 'priority'],
    hidden: true,
    response: { ok: true, id: 'iss_LIN_DEMO_001', url: 'https://linear.app/shogo/issue/SHO-1234', identifier: 'SHO-1234' },
  },
  GITHUB_CREATE_PR: {
    type: 'static',
    description: 'Open a GitHub pull request.',
    paramKeys: ['repo', 'title', 'body', 'head', 'base'],
    hidden: true,
    response: {
      ok: true,
      pull_number: 4242,
      html_url: 'https://github.com/shogo-ai/shogo/pull/4242',
      head: 'fix/voice-call-3min-timeout',
      base: 'main',
    },
  },
  GITHUB_CREATE_COMMENT: {
    type: 'static',
    description: 'Comment on a GitHub PR or issue.',
    paramKeys: ['repo', 'issue_number', 'body'],
    hidden: true,
    response: { ok: true, id: 'cmt_DEMO_0001', url: 'https://github.com/shogo-ai/shogo/pull/4242#issuecomment-0001' },
  },
  GITHUB_LIST_REVIEWS: {
    type: 'static',
    description: 'List reviews on a PR.',
    paramKeys: ['repo', 'pull_number'],
    hidden: true,
    response: {
      ok: true,
      reviews: [
        { id: 'rev_001', user: 'security-reviewer-bot', state: 'APPROVED', body: 'No new credentials, no SQL injection risk, no PII logged. LGTM.' },
        { id: 'rev_002', user: 'code-quality-reviewer-bot', state: 'COMMENTED', body: 'Minor: extract the timeout constant to env.ts and add a unit test for the boundary.' },
      ],
    },
  },
  send_message: {
    type: 'static',
    response: { ok: true, delivered: true, channel: 'demo-mock-channel' },
  },
}
