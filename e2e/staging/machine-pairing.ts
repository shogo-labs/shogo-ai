// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pair *this* machine to a cloud — an isolated local API, its own data dir and
 * DB — and hand the spec a machine that the cloud's `/api/machines` lists.
 *
 * Why a second process: `getShogoCloudUrl()` is process-wide
 * (`apps/api/src/lib/cloud-urls.ts`), so re-pointing the desktop app at staging
 * would take this Mac out of production. Nothing here touches the real
 * `~/Library/Application Support/Shogo`.
 *
 * The chain (verified from a pod 2026-10-21):
 *   sign up → onboarding `intent` → `cli/login/start` → `approve` → `poll` for
 *   the device key → boot `apps/api` with `SHOGO_CLOUD_URL` + `SHOGO_API_KEY` +
 *   `SHOGO_INSTANCE_NAME` → the tunnel registers as `kind: 'desktop'`.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

export interface PairedMachine {
  machineId: string
  machineName: string
  /** A workspace the machine offers, as the cloud sees it. */
  machineWorkspaceId: string
  machineWorkspaceName: string
  cloudWorkspaceId: string
  cloudWorkspaceName: string
  localApiBase: string
  email: string
  password: string
  /** The cloud session as a `Cookie` header, for injecting into a context. */
  cookies: string
  /** The machine's own local session, for its file API. */
  localCookies: string
  /** The device key `cli/login` minted for this machine. */
  deviceKey: string
  dir: string
  /** Every line the desktop process has printed, for a failure message. */
  log: string[]
  /** Kill the desktop process and drop its data. */
  stop: () => Promise<void>
  /** Kill the desktop process, keeping its database and files (the machine is switched off). */
  kill: () => Promise<void>
  /** Start the desktop again on the database and files it left behind. */
  restart: () => Promise<void>
}

export interface PairMachineOptions {
  instanceName: string
  /** Where the desktop keeps its database and files. Default: `test-results/staging-machine/<random>`. */
  dir?: string
  /** Extra env for the desktop process (a scripted model, a runtime port range). */
  env?: Record<string, string | undefined>
  /** Repository root, so the helper works from any cwd (Playwright runs from the root, `bun test` from apps/api). */
  repoRoot?: string
  /** How long to wait for the cloud to list the machine. */
  listTimeoutMs?: number
}

async function call(
  base: string,
  jarState: { cookie: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      // Better Auth rejects a browserless call without an Origin
      // (MISSING_OR_NULL_ORIGIN) on sign-up.
      origin: base,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(jarState.cookie ? { cookie: jarState.cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const set = res.headers.getSetCookie?.() ?? []
  if (set.length) jarState.cookie = set.map((c) => c.split(";")[0]).join("; ")
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* text only */
  }
  return { status: res.status, json, text }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A port nothing on this host is listening on. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolvePort(port))
    })
  })
}

/**
 * Pair an isolated local API to `cloudBase` and wait until the cloud lists it.
 * Returns the machine plus a `stop()` that kills the process and drops its data.
 */
export async function pairMachine(cloudBase: string, opts: PairMachineOptions): Promise<PairedMachine> {
  const { instanceName } = opts
  const repoRoot = opts.repoRoot ?? resolve(__dirname, "../..")
  const suffix = Math.random().toString(36).slice(2, 8)
  const dir = opts.dir ?? resolve(repoRoot, `test-results/staging-machine/${suffix}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const email = `sho130-${suffix}@shogo.test`
  const password = `Shogo-130-${suffix}-pw`
  const state = { cookie: "" }

  const signUp = await call(cloudBase, state, "POST", "/api/auth/sign-up/email", {
    email,
    password,
    name: `SHO130 ${suffix}`,
  })
  if (signUp.status >= 400) throw new Error(`staging sign-up failed (${signUp.status}): ${signUp.text.slice(0, 300)}`)

  const onboard = await call(cloudBase, state, "POST", "/api/onboarding/complete", {
    intent: "team",
    workspaceName: `SHO130 ${suffix}`,
  })
  if (onboard.status >= 400) throw new Error(`staging onboarding failed (${onboard.status}): ${onboard.text.slice(0, 300)}`)

  const list = await call(cloudBase, state, "GET", "/api/workspaces")
  const workspaces: Array<{ id: string; name: string; kind: string }> = list.json?.items ?? []
  const cloud = workspaces.find((w) => w.kind !== "personal") ?? workspaces[0]
  if (!cloud?.id) throw new Error(`staging account has no workspace: ${list.text.slice(0, 300)}`)

  const start = await call(cloudBase, state, "POST", "/api/cli/login/start", {
    deviceId: `sho130-${suffix}-device`,
    deviceName: instanceName,
    client: "cli",
    workspaceId: cloud.id,
  })
  const pendingState: string | undefined = start.json?.state
  if (!pendingState) throw new Error(`cli/login/start gave no state: ${start.text.slice(0, 300)}`)

  const approve = await call(cloudBase, state, "POST", "/api/cli/login/approve", {
    state: pendingState,
    workspaceId: cloud.id,
  })
  if (approve.status >= 400) throw new Error(`cli/login/approve failed (${approve.status}): ${approve.text.slice(0, 300)}`)

  const poll = await call(cloudBase, state, "GET", `/api/cli/login/poll?state=${encodeURIComponent(pendingState)}`)
  const deviceKey: string | undefined = poll.json?.key
  if (!deviceKey) throw new Error(`cli/login/poll gave no key: ${poll.text.slice(0, 300)}`)

  const push = spawn(
    "bunx",
    ["prisma", "db", "push", "--schema=prisma/schema.local.prisma", "--url", `file:${dir}/machine.db`, "--accept-data-loss"],
    { stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot },
  )
  await new Promise((r) => push.on("exit", r))

  // The desktop, started the way the product starts it: its own API is
  // `SHOGO_API_URL`, the cloud is `SHOGO_CLOUD_URL`, and the device key is the
  // tunnel's credential. Handing it the cloud's address as its API is what hid
  // the workspace-move loop (PR #1822).
  const port = await freePort()
  const localApiBase = `http://127.0.0.1:${port}`
  const log: string[] = []
  let api: ChildProcess | null = null
  const launch = () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries({
      ...process.env,
      SHOGO_LOCAL_MODE: "true",
      SHOGO_APP_DATABASE_URL: `file:${dir}/machine.db`,
      SHOGO_DATA_DIR: `${dir}/data`,
      WORKSPACES_DIR: `${dir}/workspaces`,
      SHOGO_API_URL: localApiBase,
      SHOGO_CLOUD_URL: cloudBase,
      SHOGO_API_KEY: deviceKey,
      SHOGO_INSTANCE_NAME: instanceName,
      API_PORT: String(port),
      PORT: String(port),
      NODE_ENV: "development",
      // Never reap another Shogo's runtimes on this host.
      SHOGO_SKIP_STALE_RUNTIME_CLEANUP: "1",
      // A cloud API's own database and Redis must not leak into the desktop.
      DATABASE_URL: undefined,
      REDIS_URL: undefined,
      ...opts.env,
    })) {
      if (v !== undefined) env[k] = v
    }
    const proc = spawn("bun", ["--no-env-file", "apps/api/src/entry.ts"], {
      env,
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    proc.stdout?.on("data", (b) => log.push(b.toString()))
    proc.stderr?.on("data", (b) => log.push(b.toString()))
    api = proc
  }
  const kill = async () => {
    const proc = api
    api = null
    if (!proc || proc.exitCode !== null) return
    const exited = new Promise((r) => proc.once("exit", r))
    proc.kill("SIGTERM")
    await Promise.race([exited, sleep(5000)])
    if (proc.exitCode === null) {
      proc.kill("SIGKILL")
      await Promise.race([exited, sleep(2000)])
    }
  }
  const stop = async () => {
    await kill()
    rmSync(dir, { recursive: true, force: true })
  }
  const waitHealthy = async () => {
    for (let i = 0; i < 90; i++) {
      try {
        const res = await fetch(`${localApiBase}/api/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return
      } catch {
        /* not up yet */
      }
      await sleep(1000)
    }
    throw new Error(`the isolated local API never came up:\n${log.join("").slice(-2000)}`)
  }
  const restart = async () => {
    await kill()
    launch()
    await waitHealthy()
  }

  launch()
  try {
    await waitHealthy()
  } catch (err) {
    await stop()
    throw err
  }

  // The machine's own session, for its file API and for renaming the workspace
  // below. `SHOGO_API_KEY` is the tunnel's credential, not a browser session.
  const local = { cookie: "" }
  const signIn = await fetch(`${localApiBase}/api/local/auto-sign-in`, { method: "POST" })
  local.cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ")

  // The tunnel registers, then the cloud's machine row fills in its workspaces.
  let machine: any = null
  const listDeadline = Date.now() + (opts.listTimeoutMs ?? 120_000)
  while (Date.now() < listDeadline) {
    const res = await call(cloudBase, state, "GET", "/api/machines")
    const rows: any[] = res.json?.machines ?? []
    machine = rows.find((m) => m.name === instanceName || m.hostname === instanceName)
    if (machine && (machine.snapshot?.workspaces ?? []).length > 0) break
    await sleep(1000)
  }
  if (!machine) {
    await stop()
    throw new Error(`the cloud never listed machine "${instanceName}":\n${log.join("").slice(-2000)}`)
  }

  // The machine's *team* workspace: its personal one is seeded with the same
  // name as the cloud's ("Local User Personal"), so it cannot prove identity.
  const offered: Array<{ id: string; name: string; kind?: string }> = machine.snapshot?.workspaces ?? []
  const teamWorkspace = offered.find((w) => w.kind !== "personal")
  if (!teamWorkspace) {
    await stop()
    throw new Error(`machine "${instanceName}" offered no team workspace: ${JSON.stringify(offered)}`)
  }

  // Rename it to something no cloud workspace could be called. Without this the
  // fixture lies: a seeded workspace is named after the cloud account, so a
  // header assertion would pass against the *cloud* workspace of the same name
  // (QA hit exactly this). The rename also proves a change made on the machine
  // reaches the cloud's snapshot.
  const machineWorkspaceName = `${instanceName} Workspace`
  const renamed = await call(localApiBase, local, "PATCH", `/api/workspaces/${teamWorkspace.id}`, {
    name: machineWorkspaceName,
  })
  if (renamed.status >= 400) {
    await stop()
    throw new Error(`could not rename the machine's workspace (${renamed.status}): ${renamed.text.slice(0, 300)}`)
  }

  let machineWorkspace = { id: teamWorkspace.id, name: teamWorkspace.name }
  for (let i = 0; i < 20; i++) {
    // The switcher's own read: one relay of the machine's live list. The cached
    // heartbeat snapshot on `/api/machines` only refreshes once a minute, so
    // waiting on it measured the heartbeat, not the rename.
    const res = await call(cloudBase, state, "GET", `/api/machines/${encodeURIComponent(machine.id)}/workspaces`)
    const ws = (res.json?.workspaces ?? []).find((w: any) => w.id === teamWorkspace.id)
    if (ws?.name === machineWorkspaceName) {
      machineWorkspace = { id: ws.id, name: ws.name }
      break
    }
    await sleep(3000)
  }
  if (machineWorkspace.name !== machineWorkspaceName) {
    await stop()
    throw new Error(
      `the cloud never showed the machine workspace rename "${machineWorkspaceName}" (still "${machineWorkspace.name}")`,
    )
  }

  return {
    machineId: machine.id,
    machineName: instanceName,
    machineWorkspaceId: machineWorkspace.id,
    machineWorkspaceName: machineWorkspace.name,
    cloudWorkspaceId: cloud.id,
    cloudWorkspaceName: cloud.name,
    localApiBase,
    email,
    password,
    cookies: state.cookie,
    localCookies: local.cookie,
    deviceKey,
    dir,
    log,
    stop,
    kill,
    restart,
  }
}

/** A canary on the machine's disk, written through the machine's own file API. */
export async function writeMachineCanary(
  machine: PairedMachine,
  path: string,
  content: string,
): Promise<number> {
  const res = await fetch(
    `${machine.localApiBase}/api/workspaces/${machine.machineWorkspaceId}/agent-proxy/agent/workspace/files/${path}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...(machine.localCookies ? { cookie: machine.localCookies } : {}) },
      body: JSON.stringify({ content }),
    },
  )
  return res.status
}
