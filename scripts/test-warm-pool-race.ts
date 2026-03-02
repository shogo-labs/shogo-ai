#!/usr/bin/env bun
/**
 * Warm Pool Race Condition Tester
 *
 * Creates N projects simultaneously and sends chat messages to each,
 * then verifies every project got a unique knativeServiceName.
 *
 * Usage:
 *   bun run scripts/test-warm-pool-race.ts [--count 4] [--base-url https://studio-staging.shogo.ai]
 *
 * Requires: a valid session cookie from the browser (set SHOGO_COOKIE env var or pass --cookie)
 */

const DEFAULT_COUNT = 4
const DEFAULT_BASE_URL = 'https://studio-staging.shogo.ai'

function parseArgs() {
  const args = process.argv.slice(2)
  let count = DEFAULT_COUNT
  let baseUrl = DEFAULT_BASE_URL
  let cookie = process.env.SHOGO_COOKIE || ''
  let workspaceId = process.env.SHOGO_WORKSPACE_ID || ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) count = parseInt(args[++i])
    if (args[i] === '--base-url' && args[i + 1]) baseUrl = args[++i]
    if (args[i] === '--cookie' && args[i + 1]) cookie = args[++i]
    if (args[i] === '--workspace-id' && args[i + 1]) workspaceId = args[++i]
  }

  if (!cookie) {
    console.error('Error: SHOGO_COOKIE env var or --cookie flag required')
    console.error('  Copy the Cookie header from your browser DevTools (Network tab)')
    process.exit(1)
  }
  if (!workspaceId) {
    console.error('Error: SHOGO_WORKSPACE_ID env var or --workspace-id flag required')
    process.exit(1)
  }

  return { count, baseUrl, cookie, workspaceId }
}

interface ProjectResult {
  index: number
  projectId: string | null
  chatSessionId: string | null
  chatStatus: number | null
  chatFirstLine: string | null
  error: string | null
  timings: { create: number; chatSession: number; chat: number }
}

async function apiRequest(
  baseUrl: string,
  method: string,
  path: string,
  cookie: string,
  body?: any,
): Promise<{ status: number; data: any; raw?: string }> {
  const url = `${baseUrl}/api${path}`
  const headers: Record<string, string> = {
    Cookie: cookie,
    'Content-Type': 'application/json',
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'follow',
  })

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
    const text = await res.text()
    return { status: res.status, data: null, raw: text }
  }

  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

async function createAndChat(
  index: number,
  baseUrl: string,
  cookie: string,
  workspaceId: string,
): Promise<ProjectResult> {
  const result: ProjectResult = {
    index,
    projectId: null,
    chatSessionId: null,
    chatStatus: null,
    chatFirstLine: null,
    error: null,
    timings: { create: 0, chatSession: 0, chat: 0 },
  }

  try {
    // 1. Create project
    const t0 = Date.now()
    const createRes = await apiRequest(baseUrl, 'POST', '/projects', cookie, {
      name: `Race Test ${index + 1} - ${Date.now()}`,
      workspaceId,
      description: `Warm pool race condition test #${index + 1}`,
      createdBy: 'test',
      tier: 'starter',
      status: 'draft',
      accessLevel: 'anyone',
      schemas: [],
      type: 'AGENT',
    })
    result.timings.create = Date.now() - t0

    if (createRes.status !== 201 || !createRes.data?.data?.id) {
      result.error = `Project create failed: ${createRes.status} ${JSON.stringify(createRes.data)}`
      return result
    }
    result.projectId = createRes.data.data.id
    console.log(`  [${index + 1}] Project created: ${result.projectId} (${result.timings.create}ms)`)

    // 2. Create chat session
    const t1 = Date.now()
    const sessionRes = await apiRequest(baseUrl, 'POST', '/chat-sessions', cookie, {
      inferredName: `Race test chat ${index + 1}`,
      contextType: 'project',
      contextId: result.projectId,
    })
    result.timings.chatSession = Date.now() - t1

    if (!sessionRes.data?.data?.id) {
      result.error = `Chat session create failed: ${sessionRes.status} ${JSON.stringify(sessionRes.data)}`
      return result
    }
    result.chatSessionId = sessionRes.data.data.id
    console.log(`  [${index + 1}] Chat session: ${result.chatSessionId} (${result.timings.chatSession}ms)`)

    // 3. Send chat message (triggers warm pod assignment via getProjectUrl)
    const t2 = Date.now()
    const chatRes = await apiRequest(
      baseUrl,
      'POST',
      `/projects/${result.projectId}/chat`,
      cookie,
      {
        messages: [
          { role: 'user', parts: [{ type: 'text', text: `Hello from race test ${index + 1}. Just say "Hi ${index + 1}" and nothing else.` }] },
        ],
        chatSessionId: result.chatSessionId,
      },
    )
    result.timings.chat = Date.now() - t2
    result.chatStatus = chatRes.status

    if (chatRes.raw) {
      const firstTextLine = chatRes.raw.split('\n').find((l: string) => l.startsWith('0:'))
      result.chatFirstLine = firstTextLine?.slice(0, 100) || '(no text)'
    }

    console.log(`  [${index + 1}] Chat responded: ${result.chatStatus} (${result.timings.chat}ms)`)
  } catch (err: any) {
    result.error = err.message
  }

  return result
}

async function checkCollisions(
  baseUrl: string,
  cookie: string,
  projectIds: string[],
): Promise<void> {
  console.log('\n--- Checking for collisions ---')

  const projects: { id: string; name: string; knativeServiceName: string | null }[] = []

  for (const pid of projectIds) {
    const res = await apiRequest(baseUrl, 'GET', `/projects/${pid}`, cookie)
    if (res.data?.data) {
      projects.push({
        id: res.data.data.id,
        name: res.data.data.name,
        knativeServiceName: res.data.data.knativeServiceName,
      })
    }
  }

  console.log('\nProject → Pod Mapping:')
  for (const p of projects) {
    console.log(`  ${p.name} (${p.id.slice(0, 8)}) → ${p.knativeServiceName || '(none)'}`)
  }

  // Check uniqueness
  const serviceNames = projects.map(p => p.knativeServiceName).filter(Boolean)
  const uniqueNames = new Set(serviceNames)

  console.log(`\nTotal projects: ${projects.length}`)
  console.log(`With pods assigned: ${serviceNames.length}`)
  console.log(`Unique pods: ${uniqueNames.size}`)

  if (serviceNames.length !== uniqueNames.size) {
    const counts = new Map<string, string[]>()
    for (const p of projects) {
      if (!p.knativeServiceName) continue
      const existing = counts.get(p.knativeServiceName) || []
      existing.push(p.name)
      counts.set(p.knativeServiceName, existing)
    }
    console.log('\n🚨 COLLISION DETECTED:')
    for (const [svc, names] of counts) {
      if (names.length > 1) {
        console.log(`  ${svc} → [${names.join(', ')}]`)
      }
    }
  } else if (serviceNames.length === projects.length) {
    console.log('\n✅ ALL PROJECTS HAVE UNIQUE PODS — no collision!')
  } else {
    console.log('\n⚠️  Some projects have no pod assigned yet (promotion may still be in progress)')
    console.log('   Re-run collision check in a few seconds')
  }
}

async function main() {
  const { count, baseUrl, cookie, workspaceId } = parseArgs()

  console.log(`\n🏁 Warm Pool Race Condition Test`)
  console.log(`   Creating ${count} projects simultaneously`)
  console.log(`   Target: ${baseUrl}`)
  console.log(`   Workspace: ${workspaceId}\n`)

  // Fire all project creations + chats concurrently
  const startAll = Date.now()
  const promises = Array.from({ length: count }, (_, i) =>
    createAndChat(i, baseUrl, cookie, workspaceId),
  )

  const results = await Promise.all(promises)
  const totalTime = Date.now() - startAll

  console.log(`\n--- Results (total: ${totalTime}ms) ---`)
  for (const r of results) {
    if (r.error) {
      console.log(`  [${r.index + 1}] ❌ Error: ${r.error}`)
    } else {
      console.log(
        `  [${r.index + 1}] ✅ project=${r.projectId?.slice(0, 8)} chat=${r.chatStatus} ` +
        `(create=${r.timings.create}ms session=${r.timings.chatSession}ms chat=${r.timings.chat}ms)`,
      )
    }
  }

  // Wait a moment for async promotions to complete
  const projectIds = results.map(r => r.projectId).filter(Boolean) as string[]
  if (projectIds.length > 0) {
    console.log('\nWaiting 5s for async promotions to settle...')
    await new Promise(r => setTimeout(r, 5000))
    await checkCollisions(baseUrl, cookie, projectIds)
  }

  // Cleanup: delete test projects
  console.log('\n--- Cleanup ---')
  for (const pid of projectIds) {
    try {
      const res = await apiRequest(baseUrl, 'DELETE', `/projects/${pid}`, cookie)
      console.log(`  Deleted ${pid.slice(0, 8)}: ${res.status}`)
    } catch (err: any) {
      console.log(`  Failed to delete ${pid.slice(0, 8)}: ${err.message}`)
    }
  }
}

main().catch(console.error)
