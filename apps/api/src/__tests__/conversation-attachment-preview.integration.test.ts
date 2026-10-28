// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Attachment previews, end to end: what the extractor derives from real file
 * bytes, and how a preview that only becomes readable *after* a message was
 * posted still reaches the client.
 *
 * The second half is the part worth having: extraction runs in the background
 * once the upload responds, so a fast sender gets a `message.created` with no
 * preview. The message has to be re-published, and both orderings — extraction
 * first, message first — need to end with the preview on screen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { zipSync } from 'fflate'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const fileText = await import('../services/conversation-file-text')

const db = prisma as any
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const enc = (text: string) => new TextEncoder().encode(text)

const DOCX = zipSync({
  'word/document.xml': enc(
    '<w:document><w:body><w:p><w:r><w:t>Renewal terms</w:t></w:r><w:r><w:tab/><w:t>net 30 &amp; auto-renew</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Second para</w:t></w:r></w:p></w:body></w:document>',
  ),
})

const PPTX = zipSync({
  'ppt/slides/slide2.xml': enc('<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:sld>'),
  'ppt/slides/slide1.xml': enc(
    '<p:sld><a:p><a:r><a:t>Kickoff</a:t></a:r></a:p><a:p><a:r><a:t>Goals</a:t></a:r></a:p></p:sld>',
  ),
})

const XLSX = zipSync({
  'xl/sharedStrings.xml': enc('<sst><si><t>Region</t></si><si><t>EMEA</t></si><si><t>APAC</t></si></sst>'),
  'xl/workbook.xml': enc('<workbook><sheets><sheet name="Q3" sheetId="1"/></sheets></workbook>'),
  'xl/worksheets/sheet1.xml': enc(
    '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>2</v></c></row>'
    + '</sheetData></worksheet>',
  ),
})

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

let seed: SeededWorkspace
let generalId: string
const events: any[] = []
let unsubscribe: (() => void) | undefined

const post = (conversationId: string, authorUserId: string, text: string, extra: Record<string, unknown> = {}) =>
  service.postMessage({ conversationId, authorType: 'user', authorUserId, text, ...extra } as any)

/** An attachment as the upload route leaves it: stored, not yet read. */
const attach = (name: string, mimeType: string) =>
  db.conversationAttachment.create({
    data: {
      conversationId: generalId, uploaderUserId: seed.owner,
      storageKey: `k-${name}-${crypto.randomUUID().slice(0, 6)}`, name, mimeType, size: 120,
    },
  })

const updatesForMessage = (messageId: string) =>
  events
    .map((envelope) => envelope.event)
    .filter((event) => event?.type === 'message.updated' && event.message?.id === messageId)

/** Events the bus delivered, unwrapped from their envelopes. */
const published = () => events.map((envelope) => envelope.event)

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) await service.listConversationsForUser(seed.workspaceId, user)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general').id
  unsubscribe = bus.subscribeWorkspaceEvents(seed.workspaceId, (event: any) => { events.push(event) })
})

beforeEach(() => {
  events.length = 0
})

afterAll(async () => {
  unsubscribe?.()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('what the extractor derives from a file', () => {
  test('a Word document keeps its search text and gains a prose preview', async () => {
    const content = await fileText.extractAttachmentContent(DOCX, DOCX_MIME, 'contract.docx')
    // Byte for byte what the extractor produced before previews existed: search
    // ranks against this string, so the preview work must not disturb it.
    expect(content.text).toBe('Renewal terms net 30 & auto-renew\nSecond para')
    expect(content.preview).toMatchObject({
      kind: 'text',
      lines: ['Renewal terms net 30 & auto-renew', 'Second para'],
    })
  })

  test('a deck becomes slide 1 plus the slide count', async () => {
    const content = await fileText.extractAttachmentContent(PPTX, PPTX_MIME, 'deck.pptx')
    expect(content.text).toBe('Kickoff\nGoals\nRoadmap')
    expect(content.preview).toMatchObject({ kind: 'slides', title: 'Kickoff', bullets: ['Goals'], count: 2 })
  })

  test('a spreadsheet becomes a real grid with its sheet name, not a bag of strings', async () => {
    const content = await fileText.extractAttachmentContent(XLSX, XLSX_MIME, 'numbers.xlsx')
    expect(content.text).toBe('Region\nEMEA\nAPAC')
    expect(content.preview).toMatchObject({
      kind: 'table',
      sheet: 'Q3',
      rows: [['Region', 'EMEA'], ['Region', 'APAC']],
    })
  })

  test('a CSV becomes a table, with quoted commas kept whole', async () => {
    const content = await fileText.extractAttachmentContent(
      enc('Region,Revenue\nEMEA,"1,200"\nAPAC,900\n'), 'text/csv', 'revenue.csv',
    )
    expect(content.preview).toMatchObject({
      kind: 'table',
      rows: [['Region', 'Revenue'], ['EMEA', '1,200'], ['APAC', '900']],
    })
  })

  test('source code keeps the indentation the search text flattens', async () => {
    const content = await fileText.extractAttachmentContent(enc('function a() {\n  return 1\n}\n'), 'text/plain', 'a.ts')
    expect(content.preview).toMatchObject({ kind: 'code', lang: 'ts' })
    expect((content.preview as { lines: string[] }).lines).toContain('  return 1')
  })

  test('markup is previewed as prose with its tags gone', async () => {
    const content = await fileText.extractAttachmentContent(enc('<p>Hello   <b>there</b></p>'), 'text/html', 'a.html')
    expect(content.preview).toMatchObject({ kind: 'text', lines: ['Hello there'] })
  })

  test('a picture, a corrupt archive, and an oversized file all yield nothing', async () => {
    const nothing = { text: null, preview: null }
    expect(await fileText.extractAttachmentContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), 'image/png', 'a.png')).toEqual(nothing)
    expect(await fileText.extractAttachmentContent(enc('not a zip'), DOCX_MIME, 'broken.docx')).toEqual(nothing)
    expect(await fileText.extractAttachmentContent(new Uint8Array(26 * 1024 * 1024), 'text/plain', 'huge.txt')).toEqual(nothing)
  })
})

describe('a preview that becomes readable after the message was posted', () => {
  test('the first render has none, and a message.updated brings it in', async () => {
    const attachment = await attach('contract.docx', DOCX_MIME)
    const { message } = await post(generalId, seed.owner, 'Contract attached', { attachmentIds: [attachment.id] })
    // Extraction had not run when the message went out.
    expect(message.attachments[0].preview).toBeNull()

    await fileText.extractAndStoreAttachmentText(attachment.id, DOCX, DOCX_MIME, 'contract.docx')

    const updates = updatesForMessage(message.id)
    expect(updates.length).toBe(1)
    expect(updates[0].message.attachments[0]).toMatchObject({ id: attachment.id })
    expect(updates[0].message.attachments[0].preview).toMatchObject({ kind: 'text' })

    const row = await db.conversationAttachment.findUnique({ where: { id: attachment.id } })
    expect(row.previewData).toMatchObject({ kind: 'text' })
  })

  test('a preview ready beforehand rides along in message.created', async () => {
    const attachment = await attach('early.docx', DOCX_MIME)
    await fileText.extractAndStoreAttachmentText(attachment.id, DOCX, DOCX_MIME, 'early.docx')
    // Nothing was linked to it yet, so nothing was announced.
    expect(published().some((event) => event?.type === 'message.updated')).toBe(false)

    const { message } = await post(generalId, seed.owner, 'Read before sending', { attachmentIds: [attachment.id] })
    expect(message.attachments[0].preview).toMatchObject({ kind: 'text' })
  })

  test('a file that was never sent is not announced', async () => {
    const attachment = await attach('draft.docx', DOCX_MIME)
    await fileText.extractAndStoreAttachmentText(attachment.id, DOCX, DOCX_MIME, 'draft.docx')
    expect(published().filter((event) => event?.type === 'message.updated')).toEqual([])
    const row = await db.conversationAttachment.findUnique({ where: { id: attachment.id } })
    expect(row.previewData).toMatchObject({ kind: 'text' })
  })
})

describe('the upload response', () => {
  // Postgres mode runs outside local mode, where uploads go to S3.
  test.skipIf(!!process.env.CHANNELS_TEST_PG_URL)('a fresh attachment comes back with no preview yet', async () => {
    const form = new FormData()
    form.append('file', new File([enc('# Notes\nSome body')], 'notes.md', { type: 'text/markdown' }))
    const res = await app.request(`/api/conversations/${generalId}/attachments`, {
      method: 'POST', headers: { 'x-user': seed.owner }, body: form,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.attachment.name).toBe('notes.md')
    // The client gets the id and url now; the preview arrives with the message.
    expect(body.attachment.preview).toBeNull()
  })
})
