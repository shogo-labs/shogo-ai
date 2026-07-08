// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// One-shot create → open(wake) → delete(teardown) timing probe, run INSIDE a
// staging api pod against localhost (bypasses Cloudflare/ingress) + the metal
// box for teardown confirmation. Not wired into CI; a manual parity check.

const API = process.env.PARITY_API || 'http://localhost:8002'
const ORIGIN = process.env.PARITY_ORIGIN || 'https://studio.staging.shogo.ai'
const BOX = process.env.PARITY_BOX || 'http://72.46.85.83:9900'
const LTK = process.env.LOAD_TEST_SECRET || ''
const base: Record<string, string> = { 'Content-Type': 'application/json', ...(LTK ? { 'X-Load-Test-Key': LTK } : {}) }

let cookie = ''
function H(origin = false): Record<string, string> {
  const h: Record<string, string> = { ...base }
  if (cookie) h.Cookie = cookie
  if (origin) h.Origin = ORIGIN
  return h
}
const ms = (t: number) => (performance.now() - t).toFixed(0)

// present | absent | error — NEVER conflate a flaky read with "absent", or a
// teardown check gives a false positive on a loaded box.
async function boxHas(pid: string): Promise<'present' | 'absent' | 'error'> {
  try {
    const vb: any = await (await fetch(`${BOX}/vms`, { signal: AbortSignal.timeout(6000) })).json()
    const hit = [...(vb.assigned || []), ...(vb.suspended || [])].some((x: any) => x.projectId === pid)
    return hit ? 'present' : 'absent'
  } catch {
    return 'error'
  }
}

const email = `parity-e2e-${Date.now()}@test.shogo.ai`
const pass = 'ParityE2E123!'
console.log(`\n=== metal parity create→open→delete flow (${email}) ===`)

// 1. signup
let t = performance.now()
let r = await fetch(`${API}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { ...base, Origin: ORIGIN },
  body: JSON.stringify({ email, password: pass, name: 'Parity E2E' }),
})
const setC = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') || '']
cookie = (setC.join(',').match(/__Secure-shogo\.[A-Za-z_]+=[^;,]+/g) || []).join('; ')
console.log(`1. signup       http=${r.status} time=${ms(t)}ms cookie=${cookie ? 'ok' : 'MISSING'}`)
if (!cookie) {
  console.log('   body:', (await r.text()).slice(0, 300))
  process.exit(1)
}

// 2. workspace
t = performance.now()
r = await fetch(`${API}/api/workspaces`, { headers: H() })
let j: any = await r.json()
const items = j.items ?? (Array.isArray(j) ? j : [])
const wsId = items[0]?.id
console.log(`2. workspace    http=${r.status} time=${ms(t)}ms wsId=${wsId}`)

// 3. create project
t = performance.now()
r = await fetch(`${API}/api/projects`, {
  method: 'POST',
  headers: H(true),
  body: JSON.stringify({ name: `parity-${Date.now()}`, workspaceId: wsId, type: 'AGENT' }),
})
j = await r.json()
const pid = j?.data?.id ?? j?.id ?? j?.project?.id ?? j?.item?.id
console.log(`3. create       http=${r.status} time=${ms(t)}ms projectId=${pid}`)
if (!pid) {
  console.log('   body:', JSON.stringify(j).slice(0, 400))
  process.exit(1)
}

// 4. open (sandbox/url?wait=true) — poll to 200; this is the cold-open/wake cost
t = performance.now()
let openMs = 0
let openCode = 0
let url = ''
let polls = 0
for (let i = 0; i < 60; i++) {
  polls++
  const rr = await fetch(`${API}/api/projects/${pid}/sandbox/url?wait=true`, { headers: H() })
  openCode = rr.status
  if (rr.status === 200) {
    const b: any = await rr.json().catch(() => ({}))
    url = b?.url ?? b?.data?.url ?? ''
    openMs = performance.now() - t
    break
  }
  if (rr.status === 202) {
    await new Promise((s) => setTimeout(s, 1000))
    continue
  }
  console.log(`   open unexpected http=${rr.status} ${(await rr.text()).slice(0, 200)}`)
  break
}
console.log(`4. open/wake    http=${openCode} time=${openMs.toFixed(0)}ms polls=${polls} url=${url.slice(0, 60)}`)

// 5. confirm placed on the metal box (retry through flaky reads)
let onBoxBefore: 'present' | 'absent' | 'error' = 'error'
for (let i = 0; i < 6; i++) {
  onBoxBefore = await boxHas(pid)
  if (onBoxBefore !== 'error') break
  await new Promise((s) => setTimeout(s, 1500))
}
console.log(`5. on box /vms  ${onBoxBefore}`)

// 6. delete — triggers afterDelete → destroyProjectRuntime → box /destroy
t = performance.now()
r = await fetch(`${API}/api/projects/${pid}`, { method: 'DELETE', headers: H(true) })
const delMs = ms(t)
console.log(`6. delete       http=${r.status} time=${delMs}ms`)
if (r.status >= 400) console.log('   body:', (await r.text()).slice(0, 300))

// 7. teardown latency — poll box /vms until a SUCCESSFUL read shows it absent
t = performance.now()
let gone = false
let lastState: 'present' | 'absent' | 'error' = 'error'
for (let i = 0; i < 40; i++) {
  lastState = await boxHas(pid)
  if (lastState === 'absent') {
    gone = true
    break
  }
  await new Promise((s) => setTimeout(s, 1000))
}
console.log(`7. teardown     goneFromBox=${gone} (last read: ${lastState}) time=${ms(t)}ms`)

// 8. box /status confirms none
try {
  const st = await (
    await fetch(`${BOX}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: pid }), signal: AbortSignal.timeout(8000) })
  ).json()
  console.log(`8. box /status  ${JSON.stringify(st)}`)
} catch (e: any) {
  console.log(`8. box /status  err ${e?.message ?? e}`)
}
console.log('=== done ===\n')
