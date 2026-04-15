// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Content Creator Mega Eval — Marcus (tech review YouTuber, ~500K subscribers)
 *
 * Five multi-turn evals mirroring the business-user suite: each phase seeds the
 * workspace with the assumed output of prior phases so phases can run
 * independently in parallel.
 *
 * Phases:
 *   1. Onboarding — email, heartbeat reminders, capabilities explanation
 *   2. Content pipeline — calendar, backlog, script template, thumbnail A/B tracker
 *   3. Sponsorship management — sponsor CRM, deal milestones, media kit, rate card
 *   4. Analytics & research — CSV dashboards, parallel trending/competitor research, demographics
 *   5. Scaling operations — hiring, repurposing, annual revenue report, pitch generator
 */

import type { AgentEval, EvalResult } from './types'
import { CONTENT_CREATOR_MOCKS } from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  toolCallArgsContain,
  toolCallCount,
  responseContains,
  toolCallsJson,
  lastSchemaPreservesModel,
} from './eval-helpers'
import { buildSkillServerSchema } from '../workspace-defaults'

// ---------------------------------------------------------------------------
// Shared canvas v2 config
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
// Validation helpers (aligned with business-user mega eval)
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function wroteCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!isCodeFile(path)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

function allCanvasCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '')
      return isCodeFile(path)
    })
    .map(t => {
      const inp = t.input as any
      return String(inp.content ?? inp.new_string ?? '')
    })
    .join('\n')
    .toLowerCase()
}

function anyCanvasCodeContains(r: EvalResult, term: string): boolean {
  return allCanvasCode(r).includes(term.toLowerCase())
}

function wroteSchema(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    return path.includes('schema.prisma')
  })
}

function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
    .some(t => {
      const content = String((t.input as any).content ?? (t.input as any).new_string ?? '')
      return content.includes(`model ${modelName}`)
    })
}

function canvasCodeFetches(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  return code.includes('fetch(') && (code.includes('localhost:') || code.includes('/api/'))
}

function subagentWasSpawned(r: EvalResult): boolean {
  return usedTool(r, 'task') || usedTool(r, 'agent_spawn')
}

function countSubagentSpawns(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'task' || tc.name === 'agent_spawn').length
}

// ---------------------------------------------------------------------------
// CSV data
// ---------------------------------------------------------------------------

/** 52 weekly rows starting 2025-04-07: views trend up ~100K–250K, other metrics in requested bands (deterministic). */
const CHANNEL_ANALYTICS_CSV = ((): string => {
  const header = 'week_start,views,subscribers_gained,revenue,watch_hours,likes,comments'
  const rows: string[] = [header]
  const start = Date.UTC(2025, 3, 7)
  for (let i = 0; i < 52; i++) {
    const d = new Date(start + i * 7 * 86400000)
    const weekStart = d.toISOString().slice(0, 10)
    const views = 100_000 + Math.floor((i * 150_000) / 51) + (i % 9) * 1_200
    const subscribersGained = 500 + (i * 29) % 1501
    const revenue = 1500 + (i * 43) % 2501
    const watchHours = 15_000 + (i * 307) % 25_001
    const likes = 5000 + (i * 191) % 10_001
    const comments = 500 + (i * 31) % 1501
    rows.push(
      `${weekStart},${views},${subscribersGained},${revenue},${watchHours},${likes},${comments}`,
    )
  }
  return rows.join('\n')
})()

const VIDEO_PERFORMANCE_CSV = [
  'video_id,title,publish_date,views,likes,comments,watch_time_hours,ctr,revenue',
  'VID-001,iPhone 17 Review,2025-04-15,450000,32000,4500,35000,8.2,6750',
  'VID-002,Best Budget Laptops 2025,2025-05-01,380000,28000,3800,30000,7.5,5700',
  'VID-003,Galaxy S26 vs iPhone 17,2025-05-20,520000,41000,6200,42000,9.1,7800',
  'VID-004,Best Wireless Earbuds,2025-06-05,290000,21000,2800,22000,6.8,4350',
  'VID-005,MacBook Air M4 Review,2025-06-25,410000,35000,4100,33000,8.5,6150',
  'VID-006,Smart Home Setup Guide,2025-07-10,180000,14000,2100,15000,5.5,2700',
  'VID-007,Best Monitors for Work,2025-07-28,220000,17000,2400,18000,6.2,3300',
  'VID-008,Pixel 10 Review,2025-08-15,480000,38000,5500,38000,8.8,7200',
  'VID-009,Back to School Tech,2025-09-01,350000,26000,3200,28000,7.2,5250',
  'VID-010,AirPods Pro 3 Review,2025-09-20,390000,30000,3900,31000,7.8,5850',
  'VID-011,Best Keyboards 2025,2025-10-05,160000,12000,1800,13000,5.2,2400',
  'VID-012,iPhone 17 Pro Max Deep Dive,2025-10-22,550000,44000,6800,44000,9.5,8250',
  'VID-013,Black Friday Deals Guide,2025-11-10,620000,48000,7500,50000,10.2,9300',
  'VID-014,Best Holiday Gift Tech,2025-11-28,480000,37000,5000,38000,8.6,7200',
  'VID-015,Year in Review 2025,2025-12-15,310000,24000,3500,25000,6.9,4650',
  'VID-016,CES 2026 Highlights,2026-01-10,420000,33000,4800,34000,8.1,6300',
  'VID-017,Galaxy S27 Leaks,2026-01-25,280000,22000,3200,22000,7.0,4200',
  'VID-018,Best Budget Phones 2026,2026-02-08,250000,19000,2600,20000,6.5,3750',
  'VID-019,MacBook Pro M5 Review,2026-02-25,470000,37000,5100,37000,8.7,7050',
  'VID-020,AI Gadgets Worth Buying,2026-03-10,340000,27000,3800,27000,7.4,5100',
  'VID-021,iPad Air M4 Review,2026-03-25,300000,23000,3100,24000,7.1,4500',
  'VID-022,Steam Deck OLED Tips,2026-03-28,265000,20000,2900,21000,6.9,3975',
  'VID-023,USB-C Hub Guide,2026-03-29,195000,15000,2100,16000,6.1,2925',
  'VID-024,Desk Setup Tour,2026-03-30,310000,24000,3400,25000,7.3,4650',
  'VID-025,Router Upgrade 2026,2026-03-31,175000,13000,1900,14000,5.8,2625',
  'VID-026,Camera Gear for Creators,2026-04-01,355000,27000,3600,28000,7.6,5325',
  'VID-027,Electric Scooter Review,2026-04-01,225000,18000,2500,19000,6.4,3375',
  'VID-028,Privacy Tools 2026,2026-04-02,290000,22000,3000,23000,7.0,4350',
  'VID-029,Minimal Phone Challenge,2026-04-02,410000,31000,4200,32000,8.0,6150',
  'VID-030,Studio Lighting Basics,2026-04-02,240000,19000,2700,20000,6.6,3600',
].join('\n')

const SPONSORSHIPS_CSV = [
  'deal_id,brand,type,amount,status,signed_date,published_date,paid_date',
  'SP-001,TechCase Co,dedicated,5000,paid,2025-05-01,2025-05-15,2025-06-15',
  'SP-002,CloudHost,integration,2500,paid,2025-06-01,2025-06-10,2025-07-10',
  'SP-003,VPN Shield,integration,3000,paid,2025-06-15,2025-06-25,2025-07-25',
  'SP-004,MonitorPro,dedicated,6000,paid,2025-07-01,2025-07-20,2025-08-20',
  'SP-005,AudioMax,mention,1000,paid,2025-08-01,2025-08-10,2025-09-10',
  'SP-006,LaptopDirect,dedicated,5500,paid,2025-09-01,2025-09-15,2025-10-15',
  'SP-007,VPN Shield,integration,3500,paid,2025-10-01,2025-10-12,2025-11-12',
  'SP-008,TechCase Co,dedicated,6000,paid,2025-11-01,2025-11-10,2025-12-10',
  'SP-009,CloudHost,integration,3000,paid,2025-12-01,2025-12-15,2026-01-15',
  'SP-010,GadgetStore,dedicated,7000,paid,2026-01-05,2026-01-20,2026-02-20',
  'SP-011,AudioMax,mention,1500,paid,2026-01-15,2026-01-25,2026-02-25',
  'SP-012,MonitorPro,dedicated,7500,paid,2026-02-01,2026-02-18,2026-03-18',
  'SP-013,VPN Shield,integration,4000,paid,2026-02-15,2026-02-28,2026-03-28',
  'SP-014,NewBrand AI,dedicated,8000,signed,2026-03-01,,,',
  'SP-015,TechCase Co,dedicated,7000,delivered,2026-03-10,2026-03-25,,',
  'SP-016,CloudHost,integration,3500,signed,2026-03-20,,,',
  'SP-017,SpeakerLab,dedicated,6500,negotiating,,,,',
  'SP-018,PhoneMart,mention,2000,outreach,,,,',
].join('\n')

// ---------------------------------------------------------------------------
// Prisma seeds (post phase 2 / post phase 3)
// ---------------------------------------------------------------------------

const PRISMA_SCHEMA_PHASE2 = buildSkillServerSchema(`model Video {
  id          String   @id @default(cuid())
  title       String
  publishDate DateTime
  status      String
  platform    String
  createdAt   DateTime @default(now())
}

model Idea {
  id               String   @id @default(cuid())
  title            String
  topic            String
  viewPotential    String
  sponsorPotential String
  effort           Int
  priorityScore    Float
  createdAt        DateTime @default(now())
}

model ScriptOutline {
  id        String   @id @default(cuid())
  videoId   String
  hook      String
  sections  String
  createdAt DateTime @default(now())
}

model ThumbnailTest {
  id         String   @id @default(cuid())
  videoTitle String
  variantA   String
  variantB   String
  ctrA       Float
  ctrB       Float
  winner     String
  createdAt  DateTime @default(now())
}`)

const PRISMA_SCHEMA_PHASE3 = `${PRISMA_SCHEMA_PHASE2}

model Sponsor {
  id            String   @id @default(cuid())
  brandName     String
  contactPerson String
  email         String
  dealStatus    String
  ratePerVideo  Float
  deliverables  String
  createdAt     DateTime @default(now())
}

model Deal {
  id               String    @id @default(cuid())
  brandName        String
  contractSigned   DateTime
  contentDelivery  DateTime
  videoPublish     DateTime
  finalPayment     DateTime
  milestoneAmounts String
  createdAt        DateTime  @default(now())
}`

// ---------------------------------------------------------------------------
// Workspace generators
// ---------------------------------------------------------------------------

function phase1Workspace(): Record<string, string> {
  return {}
}

function phase2Workspace(): Record<string, string> {
  return {
    'config.json': V2_CONFIG,
    'src/App.tsx': [
      'import React from "react"',
      'export default function App() {',
      '  return <div className="p-4"><h1 className="text-2xl font-bold">Marcus Reviews</h1></div>',
      '}',
    ].join('\n'),
  }
}

/** Assumed workspace after phase 2 (pipeline) — Prisma models for calendar, backlog, thumbnails. */
function phase3SeedWorkspace(): Record<string, string> {
  return {
    ...phase2Workspace(),
    '.shogo/server/schema.prisma': PRISMA_SCHEMA_PHASE2,
  }
}

/** Assumed workspace after phase 3 (sponsors) — extends schema with CRM and deal tracking. */
function phase4SeedWorkspace(): Record<string, string> {
  return {
    ...phase2Workspace(),
    '.shogo/server/schema.prisma': PRISMA_SCHEMA_PHASE3,
  }
}

/** Phase 4 eval: phase 3 output plus analytics CSVs. */
function phase4EvalWorkspace(): Record<string, string> {
  return {
    ...phase4SeedWorkspace(),
    'files/channel-analytics.csv': CHANNEL_ANALYTICS_CSV,
    'files/video-performance.csv': VIDEO_PERFORMANCE_CSV,
  }
}

/** Phase 5 eval: phase 4 workspace plus sponsorship export. */
function phase5EvalWorkspace(): Record<string, string> {
  return {
    ...phase4EvalWorkspace(),
    'files/sponsorships.csv': SPONSORSHIPS_CSV,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Onboarding (creator-onboarding) — Level 2, 26 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'creator-onboarding',
  name: 'Content Creator: Onboarding — email, heartbeat, capabilities',
  category: 'content-creator' as any,
  level: 2,
  pipeline: 'content-creator',
  pipelinePhase: 1,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        "Hey! I'm Marcus, I make tech review videos on YouTube — about 500K subscribers. " +
        "I want help managing the business side — sponsorships, content planning, analytics. I don't code at all.",
    },
    {
      role: 'user',
      content:
        'Connect my email — marcus@marcusreviews.com, IMAP is imap.marcusreviews.com, ' +
        'SMTP is smtp.marcusreviews.com, password fakepass789',
    },
    {
      role: 'user',
      content:
        "Can you remind me every Monday and Thursday morning to batch-record content? " +
        "I'm way more productive when I batch.",
    },
  ],
  input:
    "What can you actually help a YouTuber with? Like specifically — I need to understand what's possible " +
    "before I start asking for things. I don't want to waste time asking for stuff you can't do.",
  workspaceFiles: phase1Workspace(),
  toolMocks: CONTENT_CREATOR_MOCKS,
  maxScore: 26,
  validationCriteria: [
    {
      id: 'email-connected',
      description: 'Connected email channel',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        usedToolAnywhere(r, 'channel_connect') &&
        toolCallArgsContain(r, 'channel_connect', 'email'),
    },
    {
      id: 'email-details',
      description: 'Email config references IMAP host',
      points: 3,
      phase: 'execution',
      validate: (r) => toolCallsJson(r).includes('imap.marcusreviews.com'),
    },
    {
      id: 'reminder-configured',
      description: 'Configured heartbeat for batch reminders',
      points: 5,
      phase: 'intention',
      validate: (r) => usedToolAnywhere(r, 'heartbeat_configure'),
    },
    {
      id: 'reminder-days',
      description: 'Heartbeat or schedule mentions Monday/Thursday or weekdays',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('monday') || json.includes('thursday') || json.includes('weekday') ||
          json.includes('1,4') || json.includes('mon') || json.includes('thu')
      },
    },
    {
      id: 'capabilities-explained',
      description: 'Explains product capabilities with substance (dashboard/app/track + length)',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        (responseContains(r, 'dashboard') || responseContains(r, 'app') || responseContains(r, 'track')) &&
        r.responseText.length > 200,
    },
    {
      id: 'no-jargon',
      description: 'Avoids implementation jargon in the final response',
      points: 4,
      phase: 'interaction',
      validate: (r) =>
        allCanvasCode(r).length === 0 &&
        !responseContains(r, 'prisma') &&
        !responseContains(r, 'typescript') &&
        !responseContains(r, 'react') &&
        !responseContains(r, 'vite'),
    },
  ],
  tags: ['content-creator'],
}

// ---------------------------------------------------------------------------
// Phase 2: Content Pipeline (creator-pipeline) — Level 3, 45 points
// ---------------------------------------------------------------------------

const PHASE_2: AgentEval = {
  id: 'creator-pipeline',
  name: 'Content Creator: Pipeline — calendar, backlog, script, thumbnails',
  category: 'content-creator' as any,
  level: 3,
  pipeline: 'content-creator',
  pipelinePhase: 2,
  pipelineFiles: { 'config.json': V2_CONFIG },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build me a content calendar. Each video has a title, publish date, status ' +
        '(idea, scripting, filming, editing, scheduled, published), and which platform it\'s for (YouTube, Shorts, TikTok).',
    },
    {
      role: 'user',
      content:
        'I also need a video idea backlog. For each idea: title, topic, estimated view potential (low/medium/high), ' +
        'sponsor potential (yes/no/maybe), effort level (1-5), and a priority score calculated from the other fields.',
    },
    {
      role: 'user',
      content:
        'Build a script outline template. Every video follows the same structure: hook (first 30 seconds), intro, ' +
        'main sections (variable), sponsor read placement, call to action, and outro. Let me fill it in per video.',
    },
  ],
  input:
    'I track which thumbnails work better. Build me a thumbnail A/B test tracker — for each video, I test variant A and variant B. ' +
    'Track the CTR for each variant and show me which won. I want to see my overall A/B test results too.',
  workspaceFiles: phase2Workspace(),
  toolMocks: CONTENT_CREATOR_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 45,
  validationCriteria: [
    {
      id: 'calendar-schema',
      description: 'Prisma schema includes Video or Content model',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Video') || schemaContainsModel(r, 'Content')),
    },
    {
      id: 'calendar-statuses',
      description: 'Canvas code references production statuses',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('scripting') || code.includes('filming') || code.includes('editing') || code.includes('scheduled')
      },
    },
    {
      id: 'calendar-ui',
      description: 'UI mentions calendar or schedule',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'calendar') || anyCanvasCodeContains(r, 'schedule'),
    },
    {
      id: 'backlog-ui',
      description: 'UI mentions backlog or ideas',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'backlog') || anyCanvasCodeContains(r, 'idea'),
    },
    {
      id: 'backlog-priority',
      description: 'Backlog code references priority or scoring',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('priority') || code.includes('score') || code.includes('rank')
      },
    },
    {
      id: 'script-template',
      description: 'Script or outline structure in UI',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'script') ||
        anyCanvasCodeContains(r, 'outline') ||
        anyCanvasCodeContains(r, 'hook'),
    },
    {
      id: 'script-sections',
      description: 'Script template includes sponsor/CTA/outro style sections',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('sponsor') || code.includes('cta') || code.includes('call to action') || code.includes('outro')
      },
    },
    {
      id: 'thumbnail-tracker',
      description: 'Thumbnail A/B or variant tracking',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'thumbnail') ||
        anyCanvasCodeContains(r, 'a/b') ||
        anyCanvasCodeContains(r, 'variant'),
    },
    {
      id: 'thumbnail-ctr',
      description: 'CTR or click rate tracked',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('ctr') || code.includes('click') || code.includes('rate')
      },
    },
    {
      id: 'thumbnail-winner',
      description: 'Winner or comparison language',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('winner') || code.includes('won') || code.includes('better') || code.includes('comparison')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas fetches local API',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['content-creator'],
}

// ---------------------------------------------------------------------------
// Phase 3: Sponsorship Management (creator-sponsors) — Level 4, 53 points
// ---------------------------------------------------------------------------

const PHASE_3: AgentEval = {
  id: 'creator-sponsors',
  name: 'Content Creator: Sponsors — CRM, milestones, media kit, rate card',
  category: 'content-creator' as any,
  level: 4,
  pipeline: 'content-creator',
  pipelinePhase: 3,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need a sponsor CRM. For each brand: name, contact person, email, deal status ' +
        '(outreach, negotiating, signed, content delivered, paid), rate per video, and what I need to deliver ' +
        '(dedicated video, 60s integration, mention, etc.).',
    },
    {
      role: 'user',
      content:
        'Build a deal tracker with payment milestones. Each deal has: contract signed date, content delivery date, ' +
        'video publish date, and final payment date. Show amounts at each milestone and flag anything past due.',
    },
    {
      role: 'user',
      content:
        'Create a media kit dashboard. Show my subscriber count (500K), average views per video (150K), ' +
        'audience demographics (70% male, 18-34 age range, top countries: US 45%, UK 15%, Canada 10%), ' +
        'engagement rate (8.5%), and my top 5 videos by views.',
    },
  ],
  input:
    'What should I charge? My average video gets 150K views, my CPM is about $18, and my engagement rate is 8.5%. ' +
    'Build me a rate card calculator — show what I should charge for a dedicated review, a 60-second integration, ' +
    'and a simple mention. Factor in engagement premium.',
  workspaceFiles: phase3SeedWorkspace(),
  toolMocks: CONTENT_CREATOR_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 53,
  validationCriteria: [
    {
      id: 'sponsor-schema',
      description: 'Schema includes sponsor/brand/deal style model',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Sponsor') || schemaContainsModel(r, 'Brand') || schemaContainsModel(r, 'Deal')),
    },
    {
      id: 'sponsor-stages',
      description: 'Pipeline stages in UI',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('outreach') || code.includes('negotiat') || code.includes('signed') || code.includes('delivered')
      },
    },
    {
      id: 'deal-milestones',
      description: 'Milestone or payment tracking UI',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'milestone') || anyCanvasCodeContains(r, 'payment'),
    },
    {
      id: 'deal-overdue',
      description: 'Past-due or overdue handling',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('overdue') || code.includes('past due') || code.includes('late')
      },
    },
    {
      id: 'media-kit',
      description: 'Media kit or subscriber stats surfaced',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'media kit') ||
        anyCanvasCodeContains(r, 'subscriber') ||
        anyCanvasCodeContains(r, '500k') ||
        anyCanvasCodeContains(r, '500,000'),
    },
    {
      id: 'media-demographics',
      description: 'Demographics or audience breakdown',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('demographic') || code.includes('age') || code.includes('male') || code.includes('country')
      },
    },
    {
      id: 'rate-card',
      description: 'Rate card with pricing language',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'rate') &&
        (anyCanvasCodeContains(r, 'charge') ||
          anyCanvasCodeContains(r, 'price') ||
          anyCanvasCodeContains(r, 'cost')),
    },
    {
      id: 'rate-tiers',
      description: 'Dedicated / integration / mention tiers',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('dedicated') || code.includes('integration') || code.includes('mention')
      },
    },
    {
      id: 'rate-cpm',
      description: 'CPM or views in calculator',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('cpm') || code.includes('18') || code.includes('view')
      },
    },
    {
      id: 'rate-engagement',
      description: 'Engagement or premium factor',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('engagement') || code.includes('8.5') || code.includes('premium')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas fetches local API',
      points: 5,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
    {
      id: 'prior-models-preserved',
      description: 'Schema preserves Video model from prior phase',
      points: 3,
      phase: 'execution',
      validate: (r) => lastSchemaPreservesModel(r, 'Video'),
    },
  ],
  tags: ['content-creator'],
}

// ---------------------------------------------------------------------------
// Phase 4: Analytics & Research (creator-analytics) — Level 4, 56 points
// ---------------------------------------------------------------------------

const PHASE_4: AgentEval = {
  id: 'creator-analytics',
  name: 'Content Creator: Analytics — CSV dashboards, research, demographics',
  category: 'content-creator' as any,
  level: 4,
  pipeline: 'content-creator',
  pipelinePhase: 4,
  pipelineFiles: {
    'files/channel-analytics.csv': CHANNEL_ANALYTICS_CSV,
    'files/video-performance.csv': VIDEO_PERFORMANCE_CSV,
  },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I put my channel analytics in the files folder. Build a dashboard showing views trend, subscriber growth, ' +
        'revenue per video, and my top performers. Make it look pro.',
    },
    {
      role: 'user',
      content:
        "Research what's trending right now in tech content — AI hardware, foldable phones, and smart home tech. Do all three at once.",
    },
    {
      role: 'user',
      content:
        'Compare my channel to MKBHD, Dave2D, and Linus Tech Tips — posting frequency, engagement style, ' +
        'and how much sponsored content they do. Research all three in parallel.',
    },
  ],
  input:
    'Build an audience demographics dashboard from my data. I want to see breakdowns by estimated age range, top countries, ' +
    'device type (mobile vs desktop), and average watch time. Use pie charts and bar charts.',
  workspaceFiles: phase4EvalWorkspace(),
  toolMocks: CONTENT_CREATOR_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 56,
  validationCriteria: [
    {
      id: 'analytics-dashboard',
      description: 'Built canvas UI for views/subscribers',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'view') || anyCanvasCodeContains(r, 'subscriber')),
    },
    {
      id: 'analytics-charts',
      description: 'Charts library usage',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart')
      },
    },
    {
      id: 'analytics-top-videos',
      description: 'Top or best performers called out',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('top') || code.includes('best') || code.includes('performer')
      },
    },
    {
      id: 'trending-parallel',
      description: 'Parallel research (sub-agents or multiple web calls)',
      points: 7,
      phase: 'intention',
      validate: (r) =>
        countSubagentSpawns(r) >= 3 || toolCallCount(r, 'web') >= 3,
    },
    {
      id: 'trending-topics',
      description: 'Trending response covers AI hardware, foldables, smart home',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'ai') &&
        (responseContains(r, 'foldable') || responseContains(r, 'phone')) &&
        (responseContains(r, 'smart home') || responseContains(r, 'home')),
    },
    {
      id: 'competitor-parallel',
      description: 'Parallel competitor research',
      points: 7,
      phase: 'intention',
      validate: (r) =>
        countSubagentSpawns(r) >= 3 || toolCallCount(r, 'web') >= 3,
    },
    {
      id: 'competitor-names',
      description: 'All three creators referenced',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'mkbhd') && responseContains(r, 'dave2d') && responseContains(r, 'linus'),
    },
    {
      id: 'demographics-dashboard',
      description: 'Demographics or audience dashboard',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'demographic') || anyCanvasCodeContains(r, 'audience')),
    },
    {
      id: 'demographics-charts',
      description: 'Pie or bar charts for breakdowns',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('piechart') || code.includes('pie') || code.includes('barchart') || code.includes('bar')
      },
    },
    {
      id: 'demographics-categories',
      description: 'Age, country, device, or mobile/desktop',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('age') || code.includes('country') || code.includes('device') || code.includes('mobile')
      },
    },
    {
      id: 'demographics-watchtime',
      description: 'Watch time or duration',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('watch') || code.includes('time') || code.includes('duration')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas fetches local API',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['content-creator'],
}

// ---------------------------------------------------------------------------
// Phase 5: Scaling Operations (creator-scaling) — Level 4, 56 points
// ---------------------------------------------------------------------------

const PHASE_5: AgentEval = {
  id: 'creator-scaling',
  name: 'Content Creator: Scaling — hiring, repurposing, revenue, pitch',
  category: 'content-creator' as any,
  level: 4,
  pipeline: 'content-creator',
  pipelinePhase: 5,
  pipelineFiles: { 'files/sponsorships.csv': SPONSORSHIPS_CSV },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need to hire people. Build a hiring tracker for an editor, thumbnail artist, and social media manager. ' +
        'For each role: applicant name, portfolio link, hourly rate, availability, and status (applied, trial, hired, rejected).',
    },
    {
      role: 'user',
      content:
        'Build a content repurposing planner. For each YouTube video, I want to track derivative content: ' +
        'a YouTube Short, a blog post, a Twitter thread, an Instagram carousel, and a podcast clip. ' +
        'Show the status of each derivative (not started, in progress, done).',
    },
    {
      role: 'user',
      content:
        'My sponsorship data is in the files folder. Compile my annual revenue report — total, breakdown by brand, ' +
        'by quarter, and growth rate vs last year. Delegate the number crunching.',
    },
  ],
  input:
    'Last thing — build a brand partnership pitch generator. I want to input a brand name and it pulls my channel stats ' +
    '(500K subs, 150K avg views, 8.5% engagement), calculates an audience fit score, suggests deliverables with pricing, ' +
    'and includes case study references from past successful sponsorships.',
  workspaceFiles: phase5EvalWorkspace(),
  toolMocks: CONTENT_CREATOR_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 56,
  validationCriteria: [
    {
      id: 'hire-tracker',
      description: 'Hiring or applicant tracking UI',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'hire') ||
        anyCanvasCodeContains(r, 'applicant') ||
        anyCanvasCodeContains(r, 'editor'),
    },
    {
      id: 'hire-roles',
      description: 'Editor, thumbnail, or social roles',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('editor') || code.includes('thumbnail') || code.includes('social media')
      },
    },
    {
      id: 'repurposing-planner',
      description: 'Repurposing or derivatives planner',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'repurpos') ||
        anyCanvasCodeContains(r, 'derivative') ||
        anyCanvasCodeContains(r, 'short'),
    },
    {
      id: 'repurposing-formats',
      description: 'Multiple derivative formats',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('blog') || code.includes('twitter') || code.includes('instagram') || code.includes('podcast')
      },
    },
    {
      id: 'repurposing-status',
      description: 'Status columns for derivatives',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('not started') || code.includes('in progress') || code.includes('done') || code.includes('status')
      },
    },
    {
      id: 'annual-delegation',
      description: 'Delegated sponsorship analysis',
      points: 6,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'annual-revenue',
      description: 'Revenue report with totals/brands/quarters',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'revenue') &&
        (responseContains(r, 'total') || responseContains(r, 'brand') || responseContains(r, 'quarter')),
    },
    {
      id: 'annual-growth',
      description: 'Growth or year-over-year language',
      points: 3,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'growth') ||
        responseContains(r, 'increase') ||
        responseContains(r, 'compared') ||
        responseContains(r, 'year'),
    },
    {
      id: 'pitch-generator',
      description: 'Pitch or partnership generator UI',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'pitch') ||
        anyCanvasCodeContains(r, 'partnership') ||
        anyCanvasCodeContains(r, 'brand'),
    },
    {
      id: 'pitch-stats',
      description: 'Channel stats in pitch UI',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('500') || code.includes('subscriber') || code.includes('150') || code.includes('view')
      },
    },
    {
      id: 'pitch-pricing',
      description: 'Pricing or rates in pitch',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('price') || code.includes('rate') || code.includes('cost') || code.includes('$')
      },
    },
    {
      id: 'pitch-case-study',
      description: 'Case study or past sponsor proof',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('case study') || code.includes('past') || code.includes('success') || code.includes('reference')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas fetches local API',
      points: 5,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['content-creator'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const CONTENT_CREATOR_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
