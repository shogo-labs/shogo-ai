// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Editor selections (#1082) carry their own text and are resolved by the
 * runtime; the API's reference enrichers must pass them (and file/folder
 * references) through untouched, in order, without any DB lookup.
 */
import { describe, expect, mock, test } from 'bun:test'

const dbCalls: string[] = []
const trap = (name: string) => (..._args: unknown[]) => {
  dbCalls.push(name)
  throw new Error(`${name} must not be called for selection/file/folder references`)
}

mock.module(require.resolve('../prisma'), () => ({
  prisma: {
    member: { findFirst: trap('member.findFirst') },
    workspace: { findUnique: trap('workspace.findUnique') },
    project: { findUnique: trap('project.findUnique'), findMany: trap('project.findMany') },
  },
}))
mock.module(require.resolve('../authz'), () => ({
  accessibleProjectsWhere: trap('accessibleProjectsWhere'),
  loadAccess: trap('loadAccess'),
}))
mock.module(require.resolve('../history-search'), () => ({
  readWorkspacePlan: trap('readWorkspacePlan'),
  renderWorkspaceTranscript: trap('renderWorkspaceTranscript'),
}))

const { enrichChatReferences, enrichProjectReferences, enrichWorkspaceReferences } = await import('../chat-references')

const references = () => [
  { type: 'file', path: 'src/a.ts', name: 'a.ts', label: '@a.ts' },
  {
    type: 'selection',
    path: 'src/big.ts',
    name: 'big.ts',
    startLine: 120,
    endLine: 140,
    text: 'const limit = settings.maxInputTokens',
    languageId: 'typescript',
    truncated: false,
    rootId: 'agent',
    label: '@big.ts:120-140',
  },
  { type: 'folder', path: 'src/rag', name: 'rag', label: '@rag' },
]

describe('chat reference enrichment', () => {
  test('selection, file and folder references pass through every enricher unchanged', async () => {
    const body = { references: references() }
    expect(await enrichWorkspaceReferences(body, 'user-1')).toBe(false)
    const project = await enrichProjectReferences(body, 'user-1', 'ws-1')
    expect(project).toEqual({ changed: false, attachProjectIds: [] })
    expect(await enrichChatReferences(body, 'user-1', 'proj-1', 'ws-1')).toBe(false)
    expect(body.references).toEqual(references())
    expect(dbCalls).toEqual([])
  })
})
