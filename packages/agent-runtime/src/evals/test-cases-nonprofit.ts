// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Nonprofit track mega eval — Amara (BrightPath)
 *
 * Five multi-turn evals for an executive director of an education nonprofit
 * with 8 tutoring locations. Each phase seeds the workspace with the assumed
 * output of prior phases so phases can run independently in parallel.
 *
 * Phases:
 *   1. Onboarding — email, calendar, heartbeat, grant deadline alerts
 *   2. Program Management — enrollment, volunteers, sites, attendance dashboard
 *   3. Fundraising — donor CRM, grant tracker, campaign thermometer, thank-you letters
 *   4. Reporting & Compliance — impact metrics, Gates report delegation, board prep, compliance checklist
 *   5. Strategic — channel analysis, expansion research, annual report, volunteer retention
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import { NONPROFIT_MOCKS } from './tool-mocks'
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
// Validation helpers
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
// Synthetic data generators
// ---------------------------------------------------------------------------

const LOCATIONS = ['Downtown', 'Eastside', 'Westside', 'Northside', 'Southgate', 'Riverside', 'Hillcrest', 'Lakewood'] as const
const PROGRAMS = ['Math Tutoring', 'Reading', 'STEM Club'] as const
const STUDENT_FIRST = [
  'Maya', 'James', 'Sophia', 'Liam', 'Olivia', 'Noah', 'Emma', 'Aiden', 'Ava', 'Ethan',
  'Isabella', 'Lucas', 'Mia', 'Jackson', 'Charlotte', 'Mason', 'Amelia', 'Logan', 'Harper', 'Caleb',
  'Evelyn', 'Owen', 'Abigail', 'Wyatt', 'Ella', 'Henry', 'Scarlett', 'Sebastian', 'Grace', 'Jack',
  'Chloe', 'Levi', 'Victoria', 'Julian', 'Riley', 'Mateo', 'Aria', 'Leo', 'Layla', 'Samuel',
  'Zoey', 'Daniel', 'Nora', 'Matthew', 'Lily', 'David', 'Hannah', 'Joseph', 'Addison', 'Gabriel',
  'Eleanor',
]
const STUDENT_LAST = [
  'Johnson', 'Chen', 'Williams', 'Brown', 'Davis', 'Martinez', 'Garcia', 'Rodriguez', 'Lee', 'Walker',
  'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson',
  'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner', 'Torres', 'Parker', 'Collins',
  'Edwards', 'Stewart', 'Morris', 'Rogers', 'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy', 'Bailey',
  'Rivera', 'Cooper', 'Richardson', 'Cox', 'Howard', 'Ward', 'Peterson', 'Gray', 'Ramirez', 'James',
  'Watson',
]

function generateStudentsCsv(): string {
  const statuses = ['active', 'graduated', 'withdrawn'] as const
  const lines = [
    'student_id,name,age,grade,location,program,enrollment_date,status,grade_improvement',
    'STU-001,Maya Johnson,12,7,Downtown,Math Tutoring,2025-09-01,active,+1.2',
    'STU-002,James Chen,11,6,Eastside,Reading,2025-09-01,active,+0.8',
    'STU-003,Sophia Williams,13,8,Downtown,STEM Club,2025-09-15,active,+1.5',
    'STU-004,Liam Brown,10,5,Westside,Math Tutoring,2025-10-01,active,+0.5',
    'STU-005,Olivia Davis,14,9,Northside,Reading,2025-09-01,graduated,+2.0',
  ]
  for (let i = 6; i <= 50; i++) {
    const id = `STU-${String(i).padStart(3, '0')}`
    const fn = STUDENT_FIRST[(i - 1) % STUDENT_FIRST.length]
    const ln = STUDENT_LAST[(i - 1) % STUDENT_LAST.length]
    const age = 9 + (i % 6)
    const grade = age - 3
    const loc = LOCATIONS[i % LOCATIONS.length]
    const prog = PROGRAMS[i % PROGRAMS.length]
    const status = statuses[i % 9 === 0 ? 1 : (i % 11 === 0 ? 2 : 0)]
    const month = String(((i % 9) + 1) % 12 + 1).padStart(2, '0')
    const day = String((i % 27) + 1).padStart(2, '0')
    const improvement = `+${((i % 20) / 10).toFixed(1)}`
    lines.push(`${id},${fn} ${ln},${age},${grade},${loc},${prog},2025-${month}-${day},${status},${improvement}`)
  }
  return lines.join('\n')
}

function generateDonationsCsv(): string {
  const lines = [
    'donation_id,donor_name,amount,date,channel,program_designated,recurring',
    'DON-001,Smith Family Foundation,25000,2025-07-01,grant,General,no',
    'DON-002,Robert Chen,500,2025-08-15,email,Math Tutoring,yes',
    'DON-003,City Education Fund,50000,2025-09-01,grant,STEM Club,no',
    'DON-004,Maria Garcia,100,2025-09-20,event,General,no',
    'DON-005,TechCorp Foundation,15000,2025-10-01,grant,STEM Club,no',
  ]
  const donors = [
    ['Patel Family Trust', 12000, 'grant', 'Reading', 'no'],
    ['Jordan Lee', 250, 'email', 'Math Tutoring', 'yes'],
    ['Women Who Code Local', 750, 'event', 'STEM Club', 'no'],
    ['Harbor Bank Charitable', 30000, 'grant', 'General', 'no'],
    ['Alex Kim', 50, 'direct mail', 'General', 'no'],
    ['Riverside Rotary', 4000, 'event', 'Math Tutoring', 'no'],
    ['State Arts Council', 18000, 'grant', 'Reading', 'no'],
    ['Taylor Brooks', 1200, 'email', 'STEM Club', 'no'],
    ['Anonymous Donor A', 5000, 'direct mail', 'General', 'no'],
    ['Bright Futures LLC', 2200, 'email', 'Math Tutoring', 'yes'],
    ['Community Foundation North', 42000, 'grant', 'General', 'no'],
    ['Chris Ng', 75, 'event', 'Reading', 'no'],
    ['Denver Gives', 8000, 'grant', 'STEM Club', 'no'],
    ['Samira Ali', 300, 'email', 'General', 'yes'],
    ['United Way Regional', 25000, 'grant', 'Math Tutoring', 'no'],
    ['Pat Morrison', 150, 'direct mail', 'Reading', 'no'],
    ['Foundation for Youth', 33000, 'grant', 'General', 'no'],
    ['Jamie Fox', 600, 'event', 'STEM Club', 'no'],
    ['Corporate Match Program', 9000, 'email', 'General', 'no'],
    ['Helping Hands Guild', 450, 'direct mail', 'Math Tutoring', 'no'],
    ['National Tutoring Initiative', 60000, 'grant', 'Reading', 'no'],
    ['Riley Adams', 2000, 'email', 'STEM Club', 'no'],
    ['Spring Gala Revenue', 12500, 'event', 'General', 'no'],
    ['Moore Philanthropy', 11000, 'grant', 'Math Tutoring', 'no'],
    ['Casey White', 40, 'email', 'Reading', 'no'],
    ['EduStart Accelerator', 7500, 'grant', 'STEM Club', 'no'],
    ['Neighborhood Council', 900, 'direct mail', 'General', 'no'],
    ['Legacy Giving Circle', 19500, 'grant', 'General', 'no'],
    ['Priya Shah', 350, 'email', 'Math Tutoring', 'yes'],
    ['Winter Benefit Night', 8800, 'event', 'Reading', 'no'],
    ['Build Up Texas', 27000, 'grant', 'STEM Club', 'no'],
    ['Quinn Martinez', 125, 'direct mail', 'General', 'no'],
    ['Scholarship Fund Partners', 41000, 'grant', 'Math Tutoring', 'no'],
    ['Ashley Green', 175, 'email', 'STEM Club', 'no'],
    ['Faith Coalition', 1600, 'event', 'Reading', 'no'],
    ['Metro Health System', 20000, 'grant', 'General', 'no'],
    ['Drew Campbell', 95, 'direct mail', 'Math Tutoring', 'no'],
  ]
  let idx = 6
  for (const [name, amt, ch, prog, rec] of donors) {
    const m = String((idx % 11) + 1).padStart(2, '0')
    const d = String((idx % 25) + 1).padStart(2, '0')
    lines.push(`DON-${String(idx).padStart(3, '0')},${name},${amt},2025-${m}-${d},${ch},${prog},${rec}`)
    idx++
    if (idx > 40) break
  }
  return lines.join('\n')
}

function generateAttendanceCsv(): string {
  const lines = ['week_start,location,program,enrolled,attended,rate']
  const msPerWeek = 7 * 24 * 60 * 60 * 1000
  const start = Date.UTC(2026, 0, 6)
  for (let w = 0; w < 10; w++) {
    const week = new Date(start + w * msPerWeek).toISOString().slice(0, 10)
    for (let li = 0; li < 8; li++) {
      const loc = LOCATIONS[li]
      const prog = PROGRAMS[(w + li) % PROGRAMS.length]
      const enrolled = 18 + ((w * 3 + li * 2) % 14)
      const attended = Math.max(10, enrolled - ((w + li) % 8))
      const rate = ((attended / enrolled) * 100).toFixed(1)
      lines.push(`${week},${loc},${prog},${enrolled},${attended},${rate}`)
    }
  }
  lines[1] = '2026-01-06,Downtown,Math Tutoring,28,24,85.7'
  lines[2] = '2026-01-06,Eastside,Reading,22,18,81.8'
  lines[3] = '2026-01-06,Westside,Math Tutoring,20,14,70.0'
  return lines.join('\n')
}

const STUDENTS_CSV = generateStudentsCsv()
const DONATIONS_CSV = generateDonationsCsv()
const ATTENDANCE_CSV = generateAttendanceCsv()

interface VolunteerRow {
  name: string
  role: string
  location: string
  startDate: string
  hoursLogged: number
  status: 'active' | 'inactive'
  backgroundCheck: 'current' | 'expired'
}

function generateVolunteersJson(): string {
  const extra: VolunteerRow[] = [
    { name: 'Emily Rhodes', role: 'Math Tutor', location: 'Riverside', startDate: '2024-11-01', hoursLogged: 210, status: 'active', backgroundCheck: 'current' },
    { name: 'Marcus Webb', role: 'Reading Tutor', location: 'Hillcrest', startDate: '2025-04-01', hoursLogged: 95, status: 'active', backgroundCheck: 'current' },
    { name: 'Priya Nair', role: 'STEM Mentor', location: 'Lakewood', startDate: '2024-08-15', hoursLogged: 380, status: 'active', backgroundCheck: 'current' },
    { name: 'Tom Haverford', role: 'Math Tutor', location: 'Southgate', startDate: '2024-09-01', hoursLogged: 40, status: 'inactive', backgroundCheck: 'current' },
    { name: 'Nina Ortiz', role: 'Reading Tutor', location: 'Downtown', startDate: '2023-06-01', hoursLogged: 520, status: 'inactive', backgroundCheck: 'expired' },
    { name: 'Ryan Cooper', role: 'STEM Mentor', location: 'Eastside', startDate: '2025-01-20', hoursLogged: 160, status: 'active', backgroundCheck: 'current' },
    { name: 'Bethany Clark', role: 'Math Tutor', location: 'Westside', startDate: '2024-02-01', hoursLogged: 400, status: 'active', backgroundCheck: 'current' },
    { name: 'Omar Fitzgerald', role: 'Reading Tutor', location: 'Northside', startDate: '2025-05-10', hoursLogged: 55, status: 'active', backgroundCheck: 'expired' },
    { name: 'Kelly Tran', role: 'STEM Mentor', location: 'Downtown', startDate: '2024-12-01', hoursLogged: 300, status: 'inactive', backgroundCheck: 'current' },
    { name: 'Victor Ramos', role: 'Math Tutor', location: 'Eastside', startDate: '2023-09-01', hoursLogged: 600, status: 'inactive', backgroundCheck: 'current' },
    { name: 'Angela Brooks', role: 'Reading Tutor', location: 'Hillcrest', startDate: '2025-02-01', hoursLogged: 130, status: 'active', backgroundCheck: 'current' },
    { name: 'Derek Yin', role: 'STEM Mentor', location: 'Riverside', startDate: '2024-10-15', hoursLogged: 240, status: 'active', backgroundCheck: 'current' },
    { name: 'Faith Okonkwo', role: 'Math Tutor', location: 'Lakewood', startDate: '2025-06-01', hoursLogged: 35, status: 'inactive', backgroundCheck: 'expired' },
    { name: 'Hugo Bertolini', role: 'Reading Tutor', location: 'Southgate', startDate: '2024-07-01', hoursLogged: 290, status: 'active', backgroundCheck: 'current' },
    { name: 'Renee Castillo', role: 'STEM Mentor', location: 'Westside', startDate: '2023-11-01', hoursLogged: 480, status: 'inactive', backgroundCheck: 'current' },
    { name: 'Ian McAllister', role: 'Math Tutor', location: 'Northside', startDate: '2025-03-20', hoursLogged: 88, status: 'active', backgroundCheck: 'current' },
    { name: 'Tasha Ellis', role: 'Reading Tutor', location: 'Downtown', startDate: '2024-04-01', hoursLogged: 340, status: 'active', backgroundCheck: 'current' },
    { name: 'Paul Singh', role: 'STEM Mentor', location: 'Eastside', startDate: '2025-07-01', hoursLogged: 22, status: 'inactive', backgroundCheck: 'current' },
  ]
  const base: VolunteerRow[] = [
    { name: 'Sarah Mitchell', role: 'Math Tutor', location: 'Downtown', startDate: '2024-09-01', hoursLogged: 320, status: 'active', backgroundCheck: 'current' },
    { name: 'David Park', role: 'Reading Tutor', location: 'Eastside', startDate: '2025-01-15', hoursLogged: 180, status: 'active', backgroundCheck: 'current' },
    { name: 'Jennifer Adams', role: 'STEM Mentor', location: 'Downtown', startDate: '2024-06-01', hoursLogged: 450, status: 'active', backgroundCheck: 'current' },
    { name: 'Michael Torres', role: 'Math Tutor', location: 'Westside', startDate: '2025-03-01', hoursLogged: 60, status: 'inactive', backgroundCheck: 'expired' },
    { name: 'Lisa Wang', role: 'Reading Tutor', location: 'Northside', startDate: '2025-02-01', hoursLogged: 140, status: 'active', backgroundCheck: 'current' },
    { name: 'Chris Brown', role: 'STEM Mentor', location: 'Southgate', startDate: '2024-09-01', hoursLogged: 280, status: 'inactive', backgroundCheck: 'current' },
  ]
  return JSON.stringify([...base, ...extra], null, 2)
}

const VOLUNTEERS_JSON = generateVolunteersJson()

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
      '  return <div className="p-4"><h1 className="text-2xl font-bold">BrightPath</h1></div>',
      '}',
    ].join('\n'),
  }
}

const PRISMA_SCHEMA_PHASE3 = buildSkillServerSchema(`model Student {
  id              String   @id @default(cuid())
  name            String
  age             Int
  grade           Int
  location        String
  program         String
  enrollmentDate  DateTime
  status          String
  createdAt       DateTime @default(now())
}

model Volunteer {
  id             String   @id @default(cuid())
  name           String
  skills         String
  availability   String
  location       String
  hoursLogged    Float
  backgroundOk   Boolean
  createdAt      DateTime @default(now())
}

model Site {
  id           String   @id @default(cuid())
  name         String
  address      String
  maxCapacity  Int
  enrollment   Int
  siteLead     String
  hours        String
  utilization  Float
  createdAt    DateTime @default(now())
}

model Donor {
  id              String    @id @default(cuid())
  name            String
  email           String
  givingLevel     String
  lifetimeGiving  Float
  lastGiftDate    DateTime?
  preferredContact String
  createdAt       DateTime  @default(now())
}

model Grant {
  id                 String    @id @default(cuid())
  funder             String
  amountRequested    Float
  deadline           DateTime
  stage              String
  reportingNotes     String
  renewalDate        DateTime?
  createdAt          DateTime  @default(now())
}`)

function phase3Workspace(): Record<string, string> {
  return {
    ...phase2Workspace(),
    'prisma/schema.prisma': PRISMA_SCHEMA_PHASE3,
  }
}

function phase4Workspace(): Record<string, string> {
  return {
    ...phase3Workspace(),
    'files/students.csv': STUDENTS_CSV,
    'files/donations.csv': DONATIONS_CSV,
    'files/attendance.csv': ATTENDANCE_CSV,
  }
}

function phase5Workspace(): Record<string, string> {
  return {
    ...phase4Workspace(),
    'files/volunteers.json': VOLUNTEERS_JSON,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Onboarding (npo-onboarding) — Level 2, 28 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'npo-onboarding',
  name: 'Nonprofit: Onboarding — email, calendar, heartbeat, grants',
  category: 'nonprofit' as any,
  level: 2,
  pipeline: 'nonprofit',
  pipelinePhase: 1,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        "I'm Amara, I run an education non-profit called BrightPath. We provide after-school tutoring " +
        'at 8 locations across the city. About 200 students, 50 volunteer tutors, and a small staff of 6. ' +
        "Grants are our lifeline and I'm always stressed about deadlines. Can you help me get organized?",
    },
    {
      role: 'user',
      content:
        'Connect my email — amara@brightpath.org, IMAP is imap.brightpath.org, SMTP is smtp.brightpath.org, ' +
        'password fakepass101',
    },
    {
      role: 'user',
      content:
        'Hook up my Google Calendar too — I need help managing board meetings and grant deadlines.',
    },
  ],
  input:
    'This is critical — alert me 30 days before any grant deadline. These are life or death for us. ' +
    'I have grants due in May, July, and October.',
  askUserResponses: [
    'Just use the email credentials I gave you. My timezone is America/New_York.',
    'The exact grant deadlines are May 15, July 1, and October 30. Set up alerts 30 days before each.',
    'Yes, please proceed. Email is the best way to reach me for alerts.',
  ],
  workspaceFiles: phase1Workspace(),
  toolMocks: NONPROFIT_MOCKS,
  maxScore: 33,
  validationCriteria: [
    // --- Interaction phase: validate the agent asks good questions ---
    {
      id: 'asked-about-deadlines',
      description: 'Agent asked for specific grant deadline dates',
      points: 3,
      phase: 'interaction',
      validate: (r) => {
        const allText = (toolCallsJson(r) + ' ' + r.responseText).toLowerCase()
        return allText.includes('ask_user') &&
          (allText.includes('deadline') || allText.includes('date') || allText.includes('when'))
      },
    },
    {
      id: 'asked-clarification',
      description: 'Agent used ask_user to clarify at least one detail',
      points: 2,
      phase: 'interaction',
      validate: (r) => toolCallsJson(r).includes('ask_user'),
    },
    // --- Execution phase: validate actual tool usage after answers ---
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
      description: 'Email config references BrightPath IMAP host',
      points: 3,
      phase: 'execution',
      validate: (r) => toolCallsJson(r).includes('imap.brightpath.org'),
    },
    {
      id: 'calendar-searched',
      description: 'Searched or configured calendar integration',
      points: 4,
      phase: 'intention',
      validate: (r) => toolCallsJson(r).includes('calendar'),
    },
    {
      id: 'calendar-installed',
      description: 'Installed calendar-related tool or MCP',
      points: 4,
      phase: 'execution',
      validate: (r) => usedToolAnywhere(r, 'tool_install') || usedToolAnywhere(r, 'mcp_install'),
    },
    {
      id: 'heartbeat-configured',
      description: 'Configured heartbeat or recurring reminders for deadlines',
      points: 6,
      phase: 'intention',
      validate: (r) => usedToolAnywhere(r, 'heartbeat_configure'),
    },
    {
      id: 'deadline-mention',
      description: 'Response acknowledges grant deadlines and alerting',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('grant') &&
          (t.includes('deadline') || t.includes('30 day') || t.includes('alert') || t.includes('remind'))
      },
    },
  ],
  tags: ['nonprofit'],
}

// ---------------------------------------------------------------------------
// Phase 2: Program Management (npo-programs) — Level 3, 48 points
// ---------------------------------------------------------------------------

const PHASE_2: AgentEval = {
  id: 'npo-programs',
  name: 'Nonprofit: Program Management — enrollment, volunteers, attendance',
  category: 'nonprofit' as any,
  level: 3,
  pipeline: 'nonprofit',
  pipelinePhase: 2,
  pipelineFiles: { 'config.json': V2_CONFIG },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build me a student enrollment tracker. For each student: name, age, grade level, which location ' +
        'they attend, which program (math tutoring, reading, STEM club), enrollment date, and status ' +
        '(active, graduated, withdrawn).',
    },
    {
      role: 'user',
      content:
        'Now a volunteer directory. Name, skills, availability (days/times), which location they\'re ' +
        'assigned to, total hours logged, and whether their background check is current.',
    },
    {
      role: 'user',
      content:
        'I need a site manager view — all 8 locations. For each: address, max capacity, current enrollment ' +
        'count, site lead name, hours of operation. Show me utilization percentage so I know which sites have room.',
    },
  ],
  input:
    'Build me an attendance dashboard. Show attendance rates by location, by program, and by week. ' +
    'I need to see a heat map or chart so I can quickly spot which sites are struggling. Flag anything below 75% attendance.',
  workspaceFiles: phase2Workspace(),
  toolMocks: NONPROFIT_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 48,
  validationCriteria: [
    {
      id: 'student-schema',
      description: 'Prisma schema includes Student or Enrollment model',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Student') || schemaContainsModel(r, 'Enrollment')),
    },
    {
      id: 'student-fields',
      description: 'Canvas code references student enrollment fields',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('grade') || code.includes('location') || code.includes('program')
      },
    },
    {
      id: 'volunteer-schema',
      description: 'Prisma schema includes Volunteer or Tutor model',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Volunteer') || schemaContainsModel(r, 'Tutor')),
    },
    {
      id: 'volunteer-fields',
      description: 'Canvas code references volunteer directory fields',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('background check') || code.includes('hours') || code.includes('availability')
      },
    },
    {
      id: 'site-manager',
      description: 'UI or code addresses sites or locations',
      points: 5,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'site') || anyCanvasCodeContains(r, 'location'),
    },
    {
      id: 'site-utilization',
      description: 'Site view includes utilization or capacity',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('utilization') || code.includes('capacity') || code.includes('%')
      },
    },
    {
      id: 'attendance-dashboard',
      description: 'Attendance dashboard or view present',
      points: 5,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'attendance'),
    },
    {
      id: 'attendance-charts',
      description: 'Uses charts or heat-style visualization',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart') || code.includes('heatmap') || code.includes('heat')
      },
    },
    {
      id: 'attendance-threshold',
      description: 'Flags or threshold for low attendance',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('75') || code.includes('threshold') || code.includes('flag') || code.includes('below') || code.includes('warning')
      },
    },
    {
      id: 'attendance-breakdown',
      description: 'Breakdowns by location, program, or week',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('location') || code.includes('program') || code.includes('week')
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
  tags: ['nonprofit'],
}

// ---------------------------------------------------------------------------
// Phase 3: Fundraising (npo-fundraising) — Level 3, 48 points
// ---------------------------------------------------------------------------

const PHASE_3: AgentEval = {
  id: 'npo-fundraising',
  name: 'Nonprofit: Fundraising — donors, grants, campaign, letters',
  category: 'nonprofit' as any,
  level: 3,
  pipeline: 'nonprofit',
  pipelinePhase: 3,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build a donor CRM. For each donor: name, email, giving level (major donor = $10K+, mid-level = ' +
        '$1K-$10K, small = under $1K), total lifetime giving, last gift date, and preferred contact method ' +
        '(email, phone, mail).',
    },
    {
      role: 'user',
      content:
        'I need a grant tracker. For each grant: funder name, amount requested, deadline, stage ' +
        '(researching, writing, submitted, awarded, rejected), reporting requirements, and renewal date. ' +
        'This is the most important app for us.',
    },
    {
      role: 'user',
      content:
        'Build a fundraising thermometer for our annual campaign. Goal is $150,000. Show amount raised, ' +
        'number of donors, days remaining, and a projected finish based on daily giving rate.',
    },
  ],
  input:
    'Build a donor thank-you letter generator. I input the donor name, gift amount, and which program ' +
    'their gift supports, and it generates a personalized thank-you letter with an impact statement ' +
    "(like 'Your $500 gift provides 100 hours of tutoring') and tax receipt information.",
  workspaceFiles: phase3Workspace(),
  toolMocks: NONPROFIT_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 48,
  validationCriteria: [
    {
      id: 'donor-schema',
      description: 'Donor model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Donor'),
    },
    {
      id: 'donor-levels',
      description: 'Donor tiers or levels represented',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('major') || code.includes('mid-level') || code.includes('mid') || code.includes('small') || code.includes('tier') || code.includes('level')
      },
    },
    {
      id: 'grant-schema',
      description: 'Grant model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Grant'),
    },
    {
      id: 'grant-stages',
      description: 'Grant pipeline stages in UI or code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('researching') || code.includes('writing') || code.includes('submitted') || code.includes('awarded')
      },
    },
    {
      id: 'grant-deadline',
      description: 'Grant deadlines tracked',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('deadline') || code.includes('due date')
      },
    },
    {
      id: 'thermometer',
      description: 'Campaign or thermometer visualization',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'thermometer') ||
        anyCanvasCodeContains(r, 'campaign') ||
        anyCanvasCodeContains(r, 'goal'),
    },
    {
      id: 'thermometer-progress',
      description: 'Progress toward fundraising goal',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('150') || code.includes('goal') || code.includes('raised') || code.includes('progress')
      },
    },
    {
      id: 'thank-you-generator',
      description: 'Thank-you or acknowledgment letter flow',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'thank') ||
        anyCanvasCodeContains(r, 'letter') ||
        anyCanvasCodeContains(r, 'acknowledgment'),
    },
    {
      id: 'thank-you-personalized',
      description: 'Personalization fields (name, amount, greeting)',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('name') || code.includes('amount') || code.includes('dear')
      },
    },
    {
      id: 'thank-you-impact',
      description: 'Impact or outcomes language',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('impact') || code.includes('hours') || code.includes('tutoring') || code.includes('provides')
      },
    },
    {
      id: 'thank-you-tax',
      description: 'Tax or receipt language',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('tax') || code.includes('receipt') || code.includes('deductible')
      },
    },
    {
      id: 'prior-models-preserved',
      description: 'Schema preserves Grant model from prior phase',
      points: 3,
      phase: 'execution',
      validate: (r) => lastSchemaPreservesModel(r, 'Grant'),
    },
  ],
  tags: ['nonprofit'],
}

// ---------------------------------------------------------------------------
// Phase 4: Reporting & Compliance (npo-reporting) — Level 4, 55 points
// ---------------------------------------------------------------------------

const PHASE_4: AgentEval = {
  id: 'npo-reporting',
  name: 'Nonprofit: Reporting & Compliance — impact, board, checklist',
  category: 'nonprofit' as any,
  level: 4,
  pipeline: 'nonprofit',
  pipelinePhase: 4,
  pipelineFiles: {
    'files/students.csv': STUDENTS_CSV,
    'files/donations.csv': DONATIONS_CSV,
    'files/attendance.csv': ATTENDANCE_CSV,
  },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build an impact metrics dashboard. Show: total students served this year, total tutoring hours ' +
        'delivered, average grade improvement, number of active sites, and total volunteer hours. ' +
        'Make it visual with charts.',
    },
    {
      role: 'user',
      content:
        'I need to compile a report for our Gates Foundation grant. They want enrollment data, attendance rates, ' +
        'and student outcomes. All the data is in the files folder. This is a big job — have your agent pull it together.',
    },
    {
      role: 'user',
      content:
        'Build a board meeting prep dashboard. Show a financial summary (donations received, grants awarded, expenses), ' +
        'program highlights (enrollment growth, attendance trends), upcoming milestones, and any risks or concerns.',
    },
  ],
  input:
    'Build a compliance checklist for each of our 8 locations. Track: background checks current (yes/no), insurance renewed (yes/no), ' +
    'fire safety inspection (date of last, due date), health inspection (date, due), annual report filed (yes/no), and ADA compliance checked (yes/no). ' +
    'I need to see at a glance which sites have issues.',
  workspaceFiles: phase4Workspace(),
  toolMocks: NONPROFIT_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 55,
  validationCriteria: [
    {
      id: 'impact-dashboard',
      description: 'Impact or metrics dashboard file',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'impact') || anyCanvasCodeContains(r, 'student') || anyCanvasCodeContains(r, 'tutoring')),
    },
    {
      id: 'impact-charts',
      description: 'Charts in impact view',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart')
      },
    },
    {
      id: 'impact-metrics',
      description: 'Students/enrollment and hours/volunteer metrics',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const a = code.includes('student') || code.includes('enrollment')
        const b = code.includes('hours') || code.includes('volunteer')
        return a && b
      },
    },
    {
      id: 'grant-report-delegation',
      description: 'Delegated Gates report work to sub-agent',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'grant-report-data',
      description: 'Response references enrollment/attendance and outcomes',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        const a = t.includes('enrollment') || t.includes('attendance')
        const b = t.includes('outcome') || t.includes('improvement') || t.includes('grade')
        return a && b
      },
    },
    {
      id: 'board-dashboard',
      description: 'Board or meeting prep dashboard',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'board') ||
        anyCanvasCodeContains(r, 'meeting') ||
        anyCanvasCodeContains(r, 'summary'),
    },
    {
      id: 'board-sections',
      description: 'Financial or program highlight sections',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('financial') || code.includes('donation') || code.includes('program') || code.includes('highlight')
      },
    },
    {
      id: 'compliance-checklist',
      description: 'Compliance checklist UI',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'compliance') ||
        anyCanvasCodeContains(r, 'checklist') ||
        anyCanvasCodeContains(r, 'inspection'),
    },
    {
      id: 'compliance-locations',
      description: 'Per-location rows or site keys',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('downtown') || code.includes('eastside') || code.includes('location') || code.includes('site')
      },
    },
    {
      id: 'compliance-items',
      description: 'Background, insurance, fire, or inspection tracking',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('background') || code.includes('insurance') || code.includes('fire') || code.includes('inspection')
      },
    },
    {
      id: 'compliance-status',
      description: 'Status indicators (yes/no, due, overdue)',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('yes') || code.includes('no') || code.includes('current') || code.includes('expired') || code.includes('due') || code.includes('overdue')
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
  tags: ['nonprofit'],
}

// ---------------------------------------------------------------------------
// Phase 5: Strategic (npo-strategic) — Level 5, 70 points
// ---------------------------------------------------------------------------

const PHASE_5: AgentEval = {
  id: 'npo-strategic',
  name: 'Nonprofit: Strategic — channels, expansion, annual report, retention',
  category: 'nonprofit' as any,
  level: 5,
  pipeline: 'nonprofit',
  pipelinePhase: 5,
  pipelineFiles: { 'files/volunteers.json': VOLUNTEERS_JSON },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Analyze our fundraising channels. Which works best — direct mail, email campaigns, events, or grants? ' +
        'My donation data is in the files folder. Delegate the analysis.',
    },
    {
      role: 'user',
      content:
        "We're thinking about expanding to 3 new cities: Austin, Denver, and Portland. Research each for education need, " +
        'cost of living, existing after-school programs, and potential grant opportunities. Do all three in parallel.',
    },
    {
      role: 'user',
      content:
        'Build a year-end annual report dashboard. Show total students served, outcomes by program, financial summary ' +
        '(revenue by source, expenses), volunteer hours contributed, expansion plans, and year-over-year comparison. ' +
        'This needs to be beautiful — it goes to our donors and board.',
    },
  ],
  input:
    'Our volunteer turnover is 40% and it\'s killing us. The volunteer data is in the files folder. Analyze patterns — ' +
    'who stays longer than a year, who leaves early, which locations retain better, and what predicts retention. ' +
    'Have your agents dig into it and give me actionable recommendations.',
  workspaceFiles: phase5Workspace(),
  toolMocks: NONPROFIT_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 70,
  validationCriteria: [
    {
      id: 'fundraising-delegation',
      description: 'Delegated channel analysis',
      points: 6,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'fundraising-channels',
      description: 'Discussion of channels and effectiveness',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        const emailMail = t.includes('email') || t.includes('mail')
        const grantEvent = t.includes('grant') || t.includes('event')
        const framing = t.includes('channel') || t.includes('source') || t.includes('effective')
        return emailMail && grantEvent && framing
      },
    },
    {
      id: 'expansion-parallel',
      description: 'Parallel research (sub-agents or multiple web calls)',
      points: 7,
      phase: 'intention',
      validate: (r) => countSubagentSpawns(r) >= 3 || toolCallCount(r, 'web') >= 3,
    },
    {
      id: 'expansion-cities',
      description: 'All three cities covered',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'austin') &&
        responseContains(r, 'denver') &&
        responseContains(r, 'portland'),
    },
    {
      id: 'expansion-factors',
      description: 'Education, cost, programs, or grants discussed',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('education') || t.includes('cost') || t.includes('program') || t.includes('grant')
      },
    },
    {
      id: 'annual-dashboard',
      description: 'Annual report dashboard file',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'annual') || anyCanvasCodeContains(r, 'report') || anyCanvasCodeContains(r, 'year')),
    },
    {
      id: 'annual-charts',
      description: 'Charts on annual dashboard',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart')
      },
    },
    {
      id: 'annual-sections',
      description: 'Students, financial, or volunteer sections',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('student') || code.includes('financial') || code.includes('volunteer')
      },
    },
    {
      id: 'annual-visual-polish',
      description: 'Annual report layout uses grid/flex with cards or sections',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return (code.includes('grid') || code.includes('flex')) && (code.includes('card') || code.includes('section'))
      },
    },
    {
      id: 'retention-delegation',
      description: 'Delegated retention analysis',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'retention-analysis',
      description: 'Retention or turnover themes',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('retention') || t.includes('turnover') || t.includes('stay') || t.includes('leave')
      },
    },
    {
      id: 'retention-factors',
      description: 'Location, hours, role, or background factors',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('location') || t.includes('hours') || t.includes('role') || t.includes('background')
      },
    },
    {
      id: 'retention-recommendations',
      description: 'Actionable recommendations',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('recommend') || t.includes('suggest') || t.includes('improve') || t.includes('action')
      },
    },
    {
      id: 'retention-data-referenced',
      description: 'References volunteer data characteristics',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('active') || t.includes('inactive') || t.includes('hour')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas fetches local API',
      points: 2,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['nonprofit'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const NONPROFIT_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
