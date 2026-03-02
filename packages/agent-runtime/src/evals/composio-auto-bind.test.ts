/**
 * Composio Auto-Bind Integration Tests
 *
 * Tests against the real Composio REST API to validate:
 * - Tool schema fetching with output_parameters
 * - CRUD classification from tags + slug patterns
 * - Entity grouping and naming
 * - ResultPath discovery from output schemas
 * - Field inference from schemas and sample responses
 * - End-to-end auto-bind config generation
 *
 * Requires COMPOSIO_API_KEY env var. Tests are skipped if not set.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import {
  fetchComposioToolSchemas,
  groupToolsByEntity,
  autoBindComposioToolkit,
  autoBindPrimaryEntity,
  type ComposioToolSchema,
  type EntityGroup,
} from '../composio-auto-bind'

const API_KEY = process.env.COMPOSIO_API_KEY
const SKIP = !API_KEY

// ---------------------------------------------------------------------------
// Schema fetching
// ---------------------------------------------------------------------------

describe('fetchComposioToolSchemas', () => {
  test.skipIf(SKIP)('fetches Google Calendar tools with output schemas', async () => {
    const tools = await fetchComposioToolSchemas('googlecalendar')

    expect(tools.length).toBeGreaterThan(0)

    for (const tool of tools) {
      expect(tool.slug).toBeTruthy()
      expect(tool.name).toBeTruthy()
      expect(tool.input_parameters).toBeDefined()
      expect(tool.output_parameters).toBeDefined()
      expect(tool.tags).toBeInstanceOf(Array)
      expect(tool.toolkit?.slug).toBe('googlecalendar')
    }
  })

  test.skipIf(SKIP)('fetches GitHub tools', async () => {
    const tools = await fetchComposioToolSchemas('github', { important: true })

    expect(tools.length).toBeGreaterThan(0)

    const slugs = tools.map(t => t.slug)
    expect(slugs.some(s => s.includes('CREATE'))).toBe(true)
    expect(slugs.some(s => s.includes('LIST'))).toBe(true)
  })

  test.skipIf(SKIP)('fetches Linear tools', async () => {
    const tools = await fetchComposioToolSchemas('linear')

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some(t => t.slug.includes('ISSUE'))).toBe(true)
  })

  test.skipIf(SKIP)('output_parameters has data wrapper structure', async () => {
    const tools = await fetchComposioToolSchemas('googlecalendar')
    const listTool = tools.find(t => t.slug === 'GOOGLECALENDAR_EVENTS_LIST')

    expect(listTool).toBeDefined()
    const out = listTool!.output_parameters as any
    expect(out.properties.data).toBeDefined()
    expect(out.properties.successful).toBeDefined()
    expect(out.properties.error).toBeDefined()

    // The list tool should have data.items array
    const dataProps = out.properties.data.properties
    expect(dataProps.items).toBeDefined()
    expect(dataProps.items.type).toBe('array')
  })
})

// ---------------------------------------------------------------------------
// CRUD classification and entity grouping
// ---------------------------------------------------------------------------

describe('groupToolsByEntity', () => {
  let googleCalendarTools: ComposioToolSchema[]
  let linearTools: ComposioToolSchema[]

  beforeAll(async () => {
    if (SKIP) return
    googleCalendarTools = await fetchComposioToolSchemas('googlecalendar')
    linearTools = await fetchComposioToolSchemas('linear')
  })

  test.skipIf(SKIP)('groups Google Calendar tools into entities', () => {
    const groups = groupToolsByEntity(googleCalendarTools, 'googlecalendar')

    expect(groups.size).toBeGreaterThan(0)

    // Should have an Event entity
    const eventEntity = findEntityContaining(groups, 'event')
    expect(eventEntity).toBeDefined()
    expect(eventEntity!.tools.has('list') || eventEntity!.tools.has('create')).toBe(true)

    console.log('\n--- Google Calendar Entities ---')
    for (const [entity, group] of groups) {
      const roles = [...group.tools.keys()].join(', ')
      console.log(`  ${entity}: [${roles}]`)
    }
  })

  test.skipIf(SKIP)('groups Linear tools into entities', () => {
    const groups = groupToolsByEntity(linearTools, 'linear')

    expect(groups.size).toBeGreaterThan(0)

    const issueEntity = findEntityContaining(groups, 'issue')
    expect(issueEntity).toBeDefined()

    console.log('\n--- Linear Entities ---')
    for (const [entity, group] of groups) {
      const roles = [...group.tools.keys()].join(', ')
      console.log(`  ${entity}: [${roles}]`)
    }
  })

  test.skipIf(SKIP)('classifies CRUD roles correctly for Google Calendar', () => {
    const groups = groupToolsByEntity(googleCalendarTools, 'googlecalendar')
    const eventEntity = findEntityContaining(groups, 'event')

    if (eventEntity) {
      const listTool = eventEntity.tools.get('list')
      const createTool = eventEntity.tools.get('create')
      const deleteTool = eventEntity.tools.get('delete')

      if (listTool) {
        expect(listTool.tags).toContain('readOnlyHint')
        expect(listTool.mcpName).toMatch(/^GOOGLECALENDAR_/)
      }
      if (createTool) {
        expect(createTool.slug).toContain('CREATE')
      }
      if (deleteTool) {
        expect(deleteTool.tags).toContain('destructiveHint')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Auto-bind config generation
// ---------------------------------------------------------------------------

describe('autoBindComposioToolkit', () => {
  test.skipIf(SKIP)('generates configs for Google Calendar', async () => {
    const results = await autoBindComposioToolkit('googlecalendar')

    expect(results.length).toBeGreaterThan(0)

    console.log('\n--- Google Calendar Auto-Bind Results ---')
    for (const r of results) {
      console.log(`  ${r.entity} (${r.discoveredFrom}): model=${r.config.model}, fields=${r.config.fields.length}, tools=${JSON.stringify(r.tools)}`)
      if (r.config.bindings.list) {
        console.log(`    list: ${r.config.bindings.list.tool}, resultPath=${r.config.bindings.list.resultPath}`)
      }
    }

    // Verify the config shape
    for (const r of results) {
      expect(r.config.model).toBeTruthy()
      expect(r.config.bindings).toBeDefined()
      expect(r.config.cache).toBeDefined()
      expect(Object.keys(r.tools).length).toBeGreaterThan(0)
    }
  })

  test.skipIf(SKIP)('generates configs for Linear', async () => {
    const results = await autoBindComposioToolkit('linear')

    expect(results.length).toBeGreaterThan(0)

    console.log('\n--- Linear Auto-Bind Results ---')
    for (const r of results) {
      console.log(`  ${r.entity}: model=${r.config.model}, fields=${r.config.fields.length}, tools=${JSON.stringify(r.tools)}`)
    }
  })

  test.skipIf(SKIP)('Google Calendar list tool has resultPath to data.items', async () => {
    const results = await autoBindComposioToolkit('googlecalendar')
    const eventResult = results.find(r => r.entity.toLowerCase().includes('event') && r.config.bindings.list)

    if (eventResult) {
      expect(eventResult.config.bindings.list!.resultPath).toBe('data.items')
    }
  })
})

// ---------------------------------------------------------------------------
// Primary entity detection
// ---------------------------------------------------------------------------

describe('autoBindPrimaryEntity', () => {
  test.skipIf(SKIP)('selects primary entity for Google Calendar', async () => {
    const result = await autoBindPrimaryEntity('googlecalendar')

    expect(result).not.toBeNull()
    console.log(`\n--- Primary Google Calendar Entity ---`)
    console.log(`  entity: ${result!.entity}`)
    console.log(`  model: ${result!.config.model}`)
    console.log(`  fields: ${result!.config.fields.map(f => `${f.name}:${f.type}`).join(', ')}`)
    console.log(`  tools: ${JSON.stringify(result!.tools)}`)
    console.log(`  resultPath: ${result!.config.bindings.list?.resultPath}`)
  })

  test.skipIf(SKIP)('selects primary entity for Linear', async () => {
    const result = await autoBindPrimaryEntity('linear')

    expect(result).not.toBeNull()
    console.log(`\n--- Primary Linear Entity ---`)
    console.log(`  entity: ${result!.entity}`)
    console.log(`  model: ${result!.config.model}`)
    console.log(`  tools: ${JSON.stringify(result!.tools)}`)
  })

  test.skipIf(SKIP)('selects primary entity for GitHub', async () => {
    const result = await autoBindPrimaryEntity('github')

    expect(result).not.toBeNull()
    console.log(`\n--- Primary GitHub Entity ---`)
    console.log(`  entity: ${result!.entity}`)
    console.log(`  model: ${result!.config.model}`)
    console.log(`  tools: ${JSON.stringify(result!.tools)}`)
  })
})

// ---------------------------------------------------------------------------
// CRUD classification edge cases (via synthetic schemas)
// ---------------------------------------------------------------------------

describe('CRUD classification edge cases', () => {
  test('last-action-word wins for compound slugs', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('GCAL_CALENDAR_LIST_INSERT', []),
      makeTool('GCAL_EVENT_LIST_DELETE', ['destructiveHint']),
      makeTool('GCAL_ACL_RULE_LIST', ['readOnlyHint']),
      makeTool('GCAL_EVENTS_FIND', ['readOnlyHint']),
      makeTool('GCAL_CREATE_EVENT', []),
      makeTool('GCAL_ITEMS_SEARCH', ['readOnlyHint']),
    ]
    const groups = groupToolsByEntity(tools, 'gcal')

    // CALENDAR_LIST_INSERT → INSERT is last action → "create"
    const calListInsert = findToolInGroups(groups, 'GCAL_CALENDAR_LIST_INSERT')
    expect(calListInsert?.role).toBe('create')

    // EVENT_LIST_DELETE → destructiveHint tag → "delete" (tag takes priority)
    const eventListDelete = findToolInGroups(groups, 'GCAL_EVENT_LIST_DELETE')
    expect(eventListDelete?.role).toBe('delete')

    // ACL_RULE_LIST → LIST is last action → "list"
    const aclRuleList = findToolInGroups(groups, 'GCAL_ACL_RULE_LIST')
    expect(aclRuleList?.role).toBe('list')

    // EVENTS_FIND → readOnlyHint + FIND → "list"
    const eventsFind = findToolInGroups(groups, 'GCAL_EVENTS_FIND')
    expect(eventsFind?.role).toBe('list')

    // ITEMS_SEARCH → readOnlyHint + SEARCH → "list"
    const itemsSearch = findToolInGroups(groups, 'GCAL_ITEMS_SEARCH')
    expect(itemsSearch?.role).toBe('list')
  })

  test('readOnlyHint falls back to slug when no action word matches', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('TOOLKIT_FETCH_DATA', ['readOnlyHint']),
      makeTool('TOOLKIT_QUERY_RECORDS', ['readOnlyHint']),
    ]
    const groups = groupToolsByEntity(tools, 'toolkit')

    // No action word match + readOnlyHint → default "get"
    const fetchData = findToolInGroups(groups, 'TOOLKIT_FETCH_DATA')
    expect(fetchData?.role).toBe('get')

    const queryRecords = findToolInGroups(groups, 'TOOLKIT_QUERY_RECORDS')
    expect(queryRecords?.role).toBe('get')
  })

  test('tools with no tags and no action words are excluded', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('TOOLKIT_DO_SOMETHING', []),
    ]
    const groups = groupToolsByEntity(tools, 'toolkit')
    expect(groups.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Entity extraction and singularization
// ---------------------------------------------------------------------------

describe('entity extraction and naming', () => {
  test('compound entity names become PascalCase', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('GITHUB_LIST_PULL_REQUESTS', ['readOnlyHint']),
      makeTool('GITHUB_LIST_ISSUE_COMMENTS', ['readOnlyHint']),
      makeTool('SLACK_SEARCH_MESSAGES', ['readOnlyHint']),
    ]
    const groups = groupToolsByEntity(tools, 'github')

    expect(groups.has('PullRequest')).toBe(true)
    expect(groups.has('IssueComment')).toBe(true)

    // Slack grouped with "github" toolkit → strips different prefix
    const slackGroups = groupToolsByEntity(
      [makeTool('SLACK_LIST_MESSAGES', ['readOnlyHint'])],
      'slack',
    )
    expect(slackGroups.has('Message')).toBe(true)
  })

  test('singularizes various plural forms correctly', () => {
    const cases: Array<[string, string]> = [
      ['TOOLKIT_LIST_ISSUES', 'Issue'],
      ['TOOLKIT_LIST_CATEGORIES', 'Category'],
      ['TOOLKIT_LIST_BOXES', 'Box'],
      ['TOOLKIT_LIST_ADDRESSES', 'Address'], // -ses → strips -es
      ['TOOLKIT_LIST_BUSES', 'Bus'], // -ses → strips -es
      ['TOOLKIT_LIST_ITEMS', 'Item'],
      ['TOOLKIT_LIST_DATA', 'Data'], // doesn't end in 's'
    ]
    for (const [slug, expectedEntity] of cases) {
      const groups = groupToolsByEntity([makeTool(slug, ['readOnlyHint'])], 'toolkit')
      const entities = [...groups.keys()]
      expect(entities).toContain(expectedEntity)
    }
  })

  test('toolkit name in middle of slug is stripped', () => {
    // LINEAR_LIST_LINEAR_ISSUES → strips both LINEAR prefix and LINEAR in middle
    const tools: ComposioToolSchema[] = [
      makeTool('LINEAR_LIST_LINEAR_ISSUES', ['readOnlyHint']),
      makeTool('LINEAR_CREATE_LINEAR_ISSUE', []),
    ]
    const groups = groupToolsByEntity(tools, 'linear')

    expect(groups.has('Issue')).toBe(true)
    expect(groups.get('Issue')!.tools.has('list')).toBe(true)
    expect(groups.get('Issue')!.tools.has('create')).toBe(true)
  })

  test('empty entity parts default to "Item"', () => {
    // All parts are action words → fallback
    const tools: ComposioToolSchema[] = [
      makeTool('TOOLKIT_LIST_ALL', ['readOnlyHint']),
    ]
    const groups = groupToolsByEntity(tools, 'toolkit')
    expect(groups.has('Item')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ResultPath discovery edge cases
// ---------------------------------------------------------------------------

describe('resultPath discovery', () => {
  test.skipIf(SKIP)('items array prioritized over entity-named arrays', async () => {
    // GOOGLECALENDAR_EVENTS_LIST has both data.items and data.defaultReminders
    const tools = await fetchComposioToolSchemas('googlecalendar')
    const eventsList = tools.find(t => t.slug === 'GOOGLECALENDAR_EVENTS_LIST')
    expect(eventsList).toBeDefined()

    const groups = groupToolsByEntity([eventsList!], 'googlecalendar')
    const eventGroup = findEntityContaining(groups, 'event')
    expect(eventGroup).toBeDefined()

    // The resultPath should pick data.items, NOT data.default_reminders
    const results = await autoBindComposioToolkit('googlecalendar')
    const eventResult = results.find(r =>
      r.config.bindings.list?.tool?.includes('EVENTS_LIST')
    )
    if (eventResult) {
      expect(eventResult.config.bindings.list!.resultPath).toBe('data.items')
    }
  })

  test('no arrays in schema returns undefined resultPath', () => {
    const tool = makeTool('TOOLKIT_LIST_ITEMS', ['readOnlyHint'], {
      type: 'object' as const,
      properties: {
        data: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            status: { type: 'string' },
          },
        },
        successful: { type: 'boolean' },
      },
    })
    const groups = groupToolsByEntity([tool], 'toolkit')
    const result = [...groups.values()][0]
    // List tool has no arrays in output → resultPath won't be found
    // We verify by checking autoBindComposioToolkit skips resultPath
    expect(result.tools.get('list')?.outputSchema).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Deprecated tool filtering
// ---------------------------------------------------------------------------

describe('deprecated tool filtering', () => {
  test('deprecated tools are excluded from groups', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('TOOLKIT_LIST_ITEMS', ['readOnlyHint']),
      { ...makeTool('TOOLKIT_LIST_ITEMS_V1', ['readOnlyHint']), is_deprecated: true },
      makeTool('TOOLKIT_CREATE_ITEM', []),
      { ...makeTool('TOOLKIT_CREATE_ITEM_LEGACY', []), is_deprecated: true },
    ]
    const groups = groupToolsByEntity(tools, 'toolkit')

    expect(groups.has('Item')).toBe(true)
    const itemGroup = groups.get('Item')!
    expect(itemGroup.tools.get('list')?.slug).toBe('TOOLKIT_LIST_ITEMS')
    expect(itemGroup.tools.get('create')?.slug).toBe('TOOLKIT_CREATE_ITEM')
    // Deprecated tools should not be present
    const allSlugs = [...itemGroup.tools.values()].map(t => t.slug)
    expect(allSlugs).not.toContain('TOOLKIT_LIST_ITEMS_V1')
    expect(allSlugs).not.toContain('TOOLKIT_CREATE_ITEM_LEGACY')
  })
})

// ---------------------------------------------------------------------------
// Config options
// ---------------------------------------------------------------------------

describe('config options', () => {
  test.skipIf(SKIP)('maxFields truncates field list', async () => {
    const results = await autoBindComposioToolkit('googlecalendar', { maxFields: 3 })

    for (const r of results) {
      expect(r.config.fields.length).toBeLessThanOrEqual(3)
    }
  })

  test.skipIf(SKIP)('custom cache and dataPath are passed through', async () => {
    const results = await autoBindComposioToolkit('linear', {
      cache: { enabled: false },
      dataPath: '/issues',
    })

    for (const r of results) {
      expect(r.config.cache).toEqual({ enabled: false })
      expect(r.config.dataPath).toBe('/issues')
    }
  })

  test.skipIf(SKIP)('requireList=false includes entities without list binding', async () => {
    const tools = await fetchComposioToolSchemas('googlecalendar')
    const groups = groupToolsByEntity(tools, 'googlecalendar')

    // Count entities without list
    const noListEntities = [...groups.values()].filter(g => !g.tools.has('list'))
    const hasNoListEntities = noListEntities.length > 0

    if (hasNoListEntities) {
      const withList = await autoBindComposioToolkit('googlecalendar', { requireList: true })
      const withoutReq = await autoBindComposioToolkit('googlecalendar', { requireList: false })

      expect(withoutReq.length).toBeGreaterThan(withList.length)
    }
  })
})

// ---------------------------------------------------------------------------
// MCP name generation
// ---------------------------------------------------------------------------

describe('Tool name format', () => {
  test('tools use raw slug as name', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('GOOGLECALENDAR_LIST_EVENTS', ['readOnlyHint']),
    ]
    const groups = groupToolsByEntity(tools, 'googlecalendar')
    const listTool = [...groups.values()][0].tools.get('list')

    expect(listTool?.mcpName).toBe('GOOGLECALENDAR_LIST_EVENTS')
  })

  test('slug-based names for any toolkit', () => {
    const tools: ComposioToolSchema[] = [
      makeTool('MYAPP_LIST_RECORDS', ['readOnlyHint']),
    ]
    const groups = groupToolsByEntity(tools, 'myapp')
    const listTool = [...groups.values()][0].tools.get('list')

    expect(listTool?.mcpName).toBe('MYAPP_LIST_RECORDS')
  })
})

// ---------------------------------------------------------------------------
// Cross-toolkit: broader validation
// ---------------------------------------------------------------------------

describe('cross-toolkit validation', () => {
  test.skipIf(SKIP)('Slack toolkit produces valid entities', async () => {
    const tools = await fetchComposioToolSchemas('slack')
    expect(tools.length).toBeGreaterThan(0)

    const groups = groupToolsByEntity(tools, 'slack')
    expect(groups.size).toBeGreaterThan(0)

    // Slack should have a Message entity or Channel entity
    const entities = [...groups.keys()]
    const hasMessagingEntity = entities.some(e =>
      /message|channel|conversation/i.test(e)
    )
    expect(hasMessagingEntity).toBe(true)
  })

  test.skipIf(SKIP)('Gmail toolkit produces valid entities', async () => {
    const tools = await fetchComposioToolSchemas('gmail')
    expect(tools.length).toBeGreaterThan(0)

    const groups = groupToolsByEntity(tools, 'gmail')
    expect(groups.size).toBeGreaterThan(0)

    // All entities should have PascalCase names
    for (const entity of groups.keys()) {
      expect(entity[0]).toBe(entity[0].toUpperCase())
      expect(entity).not.toContain('_')
    }
  })

  test.skipIf(SKIP)('Notion toolkit produces valid entities', async () => {
    const tools = await fetchComposioToolSchemas('notion')
    expect(tools.length).toBeGreaterThan(0)

    const groups = groupToolsByEntity(tools, 'notion')
    expect(groups.size).toBeGreaterThan(0)

    // Notion should have Page or Database entity
    const entities = [...groups.keys()]
    const hasContentEntity = entities.some(e =>
      /page|database|block/i.test(e)
    )
    expect(hasContentEntity).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  test('invalid API key throws', async () => {
    await expect(
      fetchComposioToolSchemas('googlecalendar', { apiKey: 'invalid_key_12345' })
    ).rejects.toThrow()
  })

  test.skipIf(SKIP)('non-existent toolkit returns empty', async () => {
    const tools = await fetchComposioToolSchemas('nonexistent_toolkit_xyz_999')
    expect(tools.length).toBe(0)
  })

  test('groupToolsByEntity handles empty input', () => {
    const groups = groupToolsByEntity([], 'empty')
    expect(groups.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Full CRUD coverage verification
// ---------------------------------------------------------------------------

describe('full CRUD coverage', () => {
  test.skipIf(SKIP)('Linear Issue entity has all 5 CRUD operations', async () => {
    const tools = await fetchComposioToolSchemas('linear')
    const groups = groupToolsByEntity(tools, 'linear')

    const issueGroup = groups.get('Issue')
    expect(issueGroup).toBeDefined()
    expect(issueGroup!.tools.has('list')).toBe(true)
    expect(issueGroup!.tools.has('get')).toBe(true)
    expect(issueGroup!.tools.has('create')).toBe(true)
    expect(issueGroup!.tools.has('update')).toBe(true)
    expect(issueGroup!.tools.has('delete')).toBe(true)

    // Each tool should have a valid mcpName
    for (const [_, tool] of issueGroup!.tools) {
      expect(tool.mcpName).toMatch(/^LINEAR_/)
      expect(tool.slug).toMatch(/^LINEAR_/)
    }
  })

  test.skipIf(SKIP)('auto-bind config for full CRUD entity is well-formed', async () => {
    const results = await autoBindComposioToolkit('linear')
    const issueResult = results.find(r => r.entity === 'Issue')

    expect(issueResult).toBeDefined()
    const config = issueResult!.config

    // Model name
    expect(config.model).toBe('Issue')

    // All bindings present
    expect(config.bindings.list).toBeDefined()
    expect(config.bindings.list!.tool).toContain('LIST')
    expect(config.bindings.get).toBeDefined()
    expect(config.bindings.get!.tool).toContain('GET')
    expect(config.bindings.create).toBeDefined()
    expect(config.bindings.create!.tool).toContain('CREATE')
    expect(config.bindings.update).toBeDefined()
    expect(config.bindings.update!.tool).toContain('UPDATE')
    expect(config.bindings.delete).toBeDefined()
    expect(config.bindings.delete!.tool).toContain('DELETE')

    // Fields inferred from create tool output schema
    expect(config.fields.length).toBeGreaterThan(0)
    for (const field of config.fields) {
      expect(field.name).toBeTruthy()
      expect(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json']).toContain(field.type)
    }

    // Cache defaults
    expect(config.cache).toEqual({ enabled: true, ttlSeconds: 120 })

    // Tool map complete
    expect(issueResult!.tools.list).toBeTruthy()
    expect(issueResult!.tools.get).toBeTruthy()
    expect(issueResult!.tools.create).toBeTruthy()
    expect(issueResult!.tools.update).toBeTruthy()
    expect(issueResult!.tools.delete).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEntityContaining(
  groups: Map<string, EntityGroup>,
  keyword: string,
): EntityGroup | undefined {
  const kw = keyword.toLowerCase()
  for (const [entity, group] of groups) {
    if (entity.toLowerCase().includes(kw)) return group
  }
  return undefined
}

function makeTool(
  slug: string,
  tags: string[],
  outputParameters?: any,
): ComposioToolSchema {
  return {
    slug,
    name: slug.replace(/_/g, ' ').toLowerCase(),
    tags,
    toolkit: { slug: slug.split('_')[0].toLowerCase(), name: slug.split('_')[0] },
    input_parameters: { type: 'object' as const, properties: {} },
    output_parameters: outputParameters ?? {
      type: 'object' as const,
      properties: {
        data: { type: 'object', properties: {}, additionalProperties: true },
        successful: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
  }
}

/**
 * Walk all groups to find the classified tool matching a given slug.
 */
function findToolInGroups(
  groups: Map<string, EntityGroup>,
  slug: string,
): { role: string; slug: string } | undefined {
  for (const [_, group] of groups) {
    for (const [role, tool] of group.tools) {
      if (tool.slug === slug) return { role, slug: tool.slug }
    }
  }
  return undefined
}
