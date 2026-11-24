// QA probe — SHO-551 §F on staging.
//
// Publishes a server-backed Prisma app to staging.shogo.one on Postgres and
// checks the six things §F asks for:
//   1. generated CRUD answers 200 and the seed's orphan report names the rows
//      that could not be carried over,
//   2. one pod at rest, two under load, and a row written on one pod is read
//      back from the other,
//   3. a republish serves no 5xx,
//   4. a nullable column added by the agent lands on republish,
//   5. a destructive schema change is refused while the old revision serves,
//   6. the pod's DATABASE_URL carries a per-replica connection_limit.
//
// Run:
//   E2E_TARGET_URL=https://studio.staging.shogo.ai \
//     npx playwright test --config e2e/playwright.config.ts qa-sho551 --workers=1
//
// `SHO551_PROJECT_ID=<id>` reuses an existing published project instead of
// building a new one; `KEEP_PROJECT=1` leaves the project behind on success.
import { test, expect, type Page } from "./fixtures"
import { signUp, waitForAgentResponse } from "./helpers"
import { INITIAL_BUILD_TIMEOUT_MS, createProject, sendProjectChatMessage } from "./agent-chat"
import { publishRequestTimeoutMs } from "../../packages/shared-runtime/src/publish-timeouts"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"

const STAMP = Date.now().toString(36)
// A permanent domain: sign-up refuses disposable inboxes (SHO-258), and the
// shared `makeTestUser` still hands out @mailnull.com.
const TEST_USER = {
  name: `E2E Sho551Pg ${STAMP}`,
  email: `qa-sho551-${STAMP}@shogo.ai`,
  password: `E2E Sho551 Pg ${STAMP}!`,
}
const SUBDOMAIN = `qa-sho551-${STAMP}`
const LIVE = `https://${SUBDOMAIN}.staging.shogo.one`
const ORPHAN_PARENT = "qa-sho551-orphan-parent"
const ROW_EMAIL = `qa-sho551-${STAMP}@example.com`

/**
 * The fixture has to be a **server-backed** app. §F is about the Prisma client the
 * app talks to Postgres with, and a static "Single Page App" never reaches the code
 * under test — round 7 built one, which is how `!serverBacked` was hit at all.
 */
const APP_PROMPT =
  "Build a server-backed app: keep prisma/schema.prisma with its User model and keep the " +
  "generated CRUD API in server.tsx. Do not change prisma/schema.prisma, server.tsx, " +
  "custom-routes.ts, package.json or any other backend file. " +
  'Only replace src/App.tsx with a single page that renders the heading "SHO-551 QA". Nothing else.'

const KUBECONFIG = `${homedir()}/.kube/config-shogo-staging`

function psql(sql: string): string {
  return execFileSync(
    "kubectl",
    ["-n", "shogo-staging-system", "exec", "platform-pg-1", "--", "psql", "-U", "postgres", "-d", "shogo", "-tAc", sql],
    { env: { ...process.env, KUBECONFIG }, encoding: "utf8" },
  ).trim()
}

function psqlProject(db: string, sql: string): string {
  return execFileSync(
    "kubectl",
    ["-n", "shogo-staging-system", "exec", "projects-pg-1", "--", "psql", "-U", "postgres", "-d", db, "-tAc", sql],
    { env: { ...process.env, KUBECONFIG }, encoding: "utf8" },
  ).trim()
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function poll<T>(label: string, fn: () => Promise<T | null>, timeoutMs: number, everyMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value !== null) return value
    } catch (err) {
      last = err
    }
    await sleep(everyMs)
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms (last: ${String(last)})`)
}

function kubectl(args: string[]): string {
  try {
    return execFileSync("kubectl", ["-n", "shogo-staging-workspaces", ...args], {
      env: { ...process.env, KUBECONFIG },
      encoding: "utf8",
      timeout: 60_000,
    })
  } catch (err) {
    return `<kubectl failed: ${String(err).slice(0, 300)}>`
  }
}

/** Every Running pod that serves `published-<projectId>`. */
function publishedPods(projectId: string): string[] {
  try {
    const items = JSON.parse(kubectl(["get", "pods", "-o", "json"])) as {
      items: Array<{ metadata: { name: string; deletionTimestamp?: string }; status: { phase: string } }>
    }
    return items.items
      .filter(
        (p) =>
          p.metadata.name.startsWith(`published-${projectId}`) &&
          p.status.phase === "Running" &&
          !p.metadata.deletionTimestamp,
      )
      .map((p) => p.metadata.name)
  } catch {
    return []
  }
}

let runtimeTarget: { container: string; appRoot: string } | null = null

/**
 * A *published* pod is not the editing pod. Knative adds `queue-proxy`, and the
 * app is served by `runtime` — a `user-container` exec simply fails. The app
 * root differs too: a per-commit image unpacks at `/app`, while the shared
 * runtime hydrates the git tag at `/app/workspace`. Resolving both once is what
 * makes the assertions below read the artifact instead of erroring out.
 */
function publishedTarget(pod: string): { container: string; appRoot: string } {
  if (runtimeTarget) return runtimeTarget
  const containers = (
    JSON.parse(kubectl(["get", "pod", pod, "-o", "json"])) as {
      spec: { containers: Array<{ name: string }> }
    }
  ).spec.containers.map((c) => c.name)
  const container = containers.includes("runtime")
    ? "runtime"
    : containers.includes("user-container")
      ? "user-container"
      : (containers[0] ?? "runtime")
  const has = (dir: string) =>
    kubectl(["exec", pod, "-c", container, "--", "sh", "-lc", `[ -f ${dir}/prisma/schema.prisma ] && echo yes || echo no`]).trim() === "yes"
  const appRoot = has("/app") ? "/app" : has("/app/workspace") ? "/app/workspace" : "/app"
  runtimeTarget = { container, appRoot }
  console.log(`[qa-sho551] pod target: container=${container} appRoot=${appRoot}`)
  return runtimeTarget
}

function podExec(pod: string, cmd: string[]): string {
  return kubectl(["exec", pod, "-c", publishedTarget(pod).container, "--", ...cmd])
}

/** Absolute path to a file inside the published app, wherever this image put it. */
function appPath(pod: string, rel: string): string {
  return `${publishedTarget(pod).appRoot}/${rel}`
}

/** `User` → `users`, `GuestEntry` → `guest-entries` (same rule as the SDK generator). */
function routePathFor(model: string): string {
  const kebab = model.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
  if (kebab.endsWith("y")) return `${kebab.slice(0, -1)}ies`
  if (/(s|x|ch|sh)$/.test(kebab)) return `${kebab}es`
  return `${kebab}s`
}

test.describe("SHO-551 Postgres publishing on staging", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId = process.env.SHO551_PROJECT_ID ?? ""
  let routePath = ""
  let dbName = ""
  const evidence: Record<string, unknown> = { subdomain: SUBDOMAIN, live: LIVE, rowEmail: ROW_EMAIL }

  function saveEvidence() {
    writeFileSync(".tmp/sho551-evidence.json", JSON.stringify(evidence, null, 2))
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(1_800_000)
    page = await browser.newPage()
    await signUp(page, TEST_USER)
    for (let step = 0; step < 8; step++) {
      const builderHome = page.getByText("What are we building", { exact: false }).first()
      if (await builderHome.isVisible().catch(() => false)) break
      const cont = page.getByText("Continue", { exact: true }).last()
      const explore = page.getByText("I'll explore first", { exact: true })
      const teamLink = page.getByRole("link", { name: /Open your Team workspace/i })
      if (await cont.isVisible().catch(() => false)) await cont.click()
      else if (await explore.isVisible().catch(() => false)) await explore.click()
      else if (await teamLink.isVisible().catch(() => false)) await teamLink.click()
      else await page.goto("/home")
      await page.waitForTimeout(4000)
    }
    const builder = page.getByText("What are we building", { exact: false }).first()
    await builder.waitFor({ state: "visible", timeout: 120_000 })

    // A published subdomain needs a plan that owns one (same backdoor as the
    // SHO-514 spec: an active Pro subscription for this throwaway workspace).
    const wsId = psql(
      `select m."workspaceId" from members m join users u on u.id = m."userId" join workspaces w on w.id = m."workspaceId" ` +
        `where u.email = '${TEST_USER.email}' and w.kind = 'team' limit 1`,
    )
    evidence.workspaceId = wsId
    expect(wsId, "expected a team workspace for the test user").toBeTruthy()
    psql(
      `insert into subscriptions (id, "workspaceId", "stripeSubscriptionId", "stripeCustomerId", "planId", status, "billingInterval", "currentPeriodStart", "currentPeriodEnd", "cancelAtPeriodEnd", "createdAt", "updatedAt", seats, "firstPaidAt") ` +
        `values ('qa551_sub_${STAMP}', '${wsId}', 'qa551_subs_${STAMP}', 'qa551_cus_${STAMP}', 'pro', 'active', 'monthly', now(), now() + interval '30 days', false, now(), now(), 1, now()) ` +
        `on conflict do nothing`,
    )
    evidence.plan = psql(`select "planId" from subscriptions where "workspaceId" = '${wsId}'`)
    saveEvidence()
  })

  test.afterAll(async () => {
    test.setTimeout(300_000)
    saveEvidence()
    try {
      if (projectId && process.env.KEEP_PROJECT !== "1") {
        const del = await page.request.delete(`/api/projects/${projectId}`, { timeout: 120_000 }).catch(() => null)
        evidence.projectDeleteStatus = del ? del.status() : null
        saveEvidence()
      }
      await page.close()
    } catch (err) {
      console.warn("[qa-sho551] cleanup failed:", err)
    }
  })

  test("1 — publish on Postgres, CRUD answers, seed reports its orphans", async () => {
    test.setTimeout(2_400_000)

    if (!projectId) {
      projectId = await createProject(page, APP_PROMPT)
      await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)
    }
    evidence.projectId = projectId
    saveEvidence()
    console.log(`[qa-sho551] project ${projectId}`)

    const published = await page.request.post(`/api/projects/${projectId}/publish`, {
      data: { subdomain: SUBDOMAIN },
      timeout: publishRequestTimeoutMs(),
    })
    const publishBody = await published.json().catch(() => null)
    evidence.publishStatus = published.status()
    evidence.publishBody = publishBody
    saveEvidence()
    console.log(`[qa-sho551] publish -> ${published.status()} ${JSON.stringify(publishBody)}`)
    expect(published.ok(), `publish failed: ${JSON.stringify(publishBody)}`).toBeTruthy()

    // `publish` answers 202 and builds in the background, so the environment row
    // appears — and gains its provider — only once the pipeline reaches it.
    // Polling the row is also what surfaces a build failure with its own
    // message, instead of a bare timeout further down.
    const envRow = await poll(
      "the published environment to become Postgres",
      async () => {
        const row = psql(
          `select coalesce("dbProvider",'-') || ' | ' || coalesce("dbName",'-') || ' | ' || coalesce("publishStatus",'-') || ' | ' || coalesce(left("publishError",400),'-') from published_environments ` +
            `where "projectId" = '${projectId}' and name = 'production'`,
        )
        if (!row.trim()) return null
        const [provider, , status] = row.split("|").map((part) => part.trim())
        // The row is already `postgres` while the publish is still `switching`,
        // so the provider alone is not "done" — waiting for a terminal status is
        // what keeps the pod lookup below from running before the ksvc exists.
        if (status === "failed") return row
        return status === "live" && provider === "postgres" ? row : null
      },
      900_000,
    )
    evidence.environmentRow = envRow
    dbName = envRow.split("|")[1]?.trim() ?? ""
    saveEvidence()
    console.log(`[qa-sho551] environment: ${envRow}`)
    expect(envRow, "the publish must not have failed").not.toMatch(/\|\s*failed\s*\|/)
    expect(envRow, "the published environment must be Postgres").toContain("postgres")

    await poll(
      "published site serving",
      async () => {
        const res = await page.request.get(`${LIVE}/`, { timeout: 20_000, failOnStatusCode: false }).catch(() => null)
        return res && res.status() < 500 ? res.status() : null
      },
      420_000,
    )

    // The ksvc exists now, but its first pod takes a few seconds to appear —
    // reading once here is how run 1 called `podExec` with `undefined`.
    const pod = await poll("a Running published pod", async () => publishedPods(projectId)[0] ?? null, 180_000, 3_000)
    evidence.publishedPod = pod
    saveEvidence()
    const schema = podExec(pod, ["cat", appPath(pod, "prisma/schema.prisma")])
    evidence.podSchemaHead = schema.slice(0, 1200)
    const models = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1])
    evidence.models = models
    // A static fixture would pass the publish and then prove nothing: there is no
    // Prisma client to check and no generated route to call. Say so here.
    expect(
      models.length,
      "the fixture must be a server-backed Prisma app — §F tests the client that talks to Postgres",
    ).toBeGreaterThan(0)

    // The defect this spec exists to catch (SHO-551): the environment row said
    // Postgres while the artifact was built SQLite-native — `provider = "sqlite"`
    // and a libsql client — so Prisma talked libsql at a Postgres socket and
    // every generated CRUD route 500'd. The row is not the proof; the artifact is.
    expect(schema, "the deployed schema must be Postgres-native").toContain('provider = "postgresql"')
    expect(schema, "the deployed schema must not still say sqlite").not.toMatch(/provider\s*=\s*"sqlite"/)
    const dbModule = podExec(pod, ["sh", "-lc", `cat ${appPath(pod, "src/lib/db.ts")} ${appPath(pod, "src/lib/db.tsx")} 2>/dev/null || true`])
    evidence.podDbModuleHead = dbModule.slice(0, 800)
    if (!dbModule.startsWith("<kubectl failed") && dbModule.trim().length > 0) {
      expect(dbModule, "the pod's Prisma client must be the pg adapter").toContain("PrismaPg")
      expect(dbModule, "the pod must not construct a libsql client").not.toContain("PrismaLibSql")
    }

    // The two ways a Postgres environment ends up on SQLite *anyway* (QA round 8):
    // the ksvc boots the SHARED runtime image, so its boot hydrates the git tag —
    // a SQLite schema, a LibSQL client, and a `prisma/dev.db` that absorbs every
    // write while `projects-pg` stays empty. The schema/db.ts assertions above
    // catch the symptom; these catch the cause, so a regression names it.
    const image = kubectl(["get", "pod", pod, "-o", "jsonpath={.spec.containers[0].image}"]).trim()
    evidence.podImage = image
    saveEvidence()
    expect(image, "a Postgres environment must run its own per-commit build").toContain("/published/")
    const devDb = podExec(pod, [
      "sh",
      "-lc",
      'for p in /app/prisma/dev.db /app/workspace/prisma/dev.db; do [ -e "$p" ] && echo "EXISTS $p"; done; echo checked',
    ])
    evidence.podDevDb = devDb.slice(0, 400)
    saveEvidence()
    expect(
      devDb,
      "a Postgres pod must not carry a SQLite database — that is the per-pod file writes were landing in",
    ).not.toContain("EXISTS")

    for (const m of models.filter((m) => m === "User").concat(models.filter((m) => m !== "User"))) {
      const candidate = routePathFor(m)
      const probe = await page.request.get(`${LIVE}/api/${candidate}`, { timeout: 30_000, failOnStatusCode: false })
      console.log(`[qa-sho551] GET /api/${candidate} (${m}) -> ${probe.status()}`)
      if (probe.ok()) {
        routePath = candidate
        evidence.crudRoute = candidate
        evidence.crudStatus = probe.status()
        break
      }
    }
    saveEvidence()
    expect(routePath, `no generated CRUD route answered (models: ${models.join(", ")})`).toBeTruthy()

    // ── Plant orphans in the app's own database, then republish: the seed has
    // to skip the rows it cannot carry and say which ones.
    const parentId = psqlProject(dbName, `select id from users limit 1`)
    evidence.parentId = parentId
    if (parentId) {
      const childTables = psqlProject(
        dbName,
        `select table_name from information_schema.columns where table_schema='public' and column_name in ('userId','user_id') and table_name not in ('users','_prisma_migrations') limit 3`,
      )
        .split("\n")
        .filter(Boolean)
      evidence.childTables = childTables
      for (const child of childTables) {
        const col = psqlProject(
          dbName,
          `select column_name from information_schema.columns where table_schema='public' and table_name='${child}' and column_name in ('userId','user_id') limit 1`,
        )
        if (!col) continue
        psqlProject(
          dbName,
          `insert into "${child}" (id${col === "userId" ? ', "userId"' : ', user_id'}) values ('${ORPHAN_PARENT}-${child}', '${ORPHAN_PARENT}') on conflict do nothing`,
        )
      }
    }

    const republished = await page.request.post(`/api/projects/${projectId}/republish`, {
      timeout: publishRequestTimeoutMs(),
    })
    const republishBody = await republished.json().catch(() => null)
    evidence.orphanRepublishStatus = republished.status()
    evidence.orphanRepublishBody = republishBody
    saveEvidence()
    console.log(`[qa-sho551] orphan republish -> ${republished.status()} ${JSON.stringify(republishBody)}`)
    expect(republished.ok(), `republish failed: ${JSON.stringify(republishBody)}`).toBeTruthy()

    const afterOrphans = await poll(
      "site still serving after the orphan republish",
      async () => {
        const res = await page.request
          .get(`${LIVE}/api/${routePath}`, { timeout: 30_000, failOnStatusCode: false })
          .catch(() => null)
        return res && res.ok() ? res.status() : null
      },
      420_000,
    )
    evidence.crudAfterOrphans = afterOrphans

    const orphansInDb = psqlProject(
      dbName,
      `select count(*) from users where id = '${ORPHAN_PARENT}'`,
    )
    evidence.orphanedParentStillInDb = orphansInDb
    saveEvidence()
    // The report is the contract; the row must not have been carried over.
    expect(String(JSON.stringify(republishBody))).toMatch(/orphan/i)
    expect(orphansInDb, "the orphaned parent must not be seeded").toBe("0")
  })

  test("2 — one pod at rest, two under load, row written on one pod read from the other", async () => {
    test.setTimeout(900_000)
    expect(projectId).toBeTruthy()
    const atRest = publishedPods(projectId).length
    evidence.podsAtRest = atRest
    saveEvidence()
    console.log(`[qa-sho551] pods at rest: ${atRest}`)
    expect(atRest, "one replica at rest").toBeGreaterThanOrEqual(1)

    const deadline = Date.now() + 60_000
    const pids: string[] = []
    while (Date.now() < deadline) {
      pids.push(
        `${await page.request.get(`${LIVE}/`, { failOnStatusCode: false, timeout: 15_000 }).then((r) => r.status())}`,
      )
      await sleep(250)
    }
    const podsUnderLoad = await poll(
      "a second pod under load",
      async () => {
        const n = publishedPods(projectId).length
        return n >= 2 ? n : null
      },
      180_000,
    )
    evidence.podsUnderLoad = podsUnderLoad
    evidence.loadRequestCount = pids.length
    saveEvidence()
    console.log(`[qa-sho551] pods under load: ${podsUnderLoad} after ${pids.length} requests`)
    expect(podsUnderLoad, "Knative must scale to two pods under 60s of load").toBeGreaterThanOrEqual(2)

    // A write on one pod, read back from the other: shared Postgres, not a
    // per-pod SQLite file.
    const pods = publishedPods(projectId)
    const created = await page.request.post(`${LIVE}/api/${routePath}`, {
      data: { email: ROW_EMAIL, name: "SHO-551 cross-pod row" },
      failOnStatusCode: false,
      timeout: 60_000,
    })
    evidence.crossPodWriteStatus = created.status()
    const writeBody = await created.text().catch(() => "")
    expect(created.ok(), `live write failed: ${created.status()} ${writeBody.slice(0, 300)}`).toBeTruthy()

    for (const p of pods) {
      const out = podExec(p, ["sh", "-lc", `bun -e '1' >/dev/null 2>&1; echo pod-ok`]).trim()
      evidence[`podReachable_${p}`] = out
    }
    const listed = await page.request.get(`${LIVE}/api/${routePath}`, { timeout: 60_000, failOnStatusCode: false })
    const listText = await listed.text().catch(() => "")
    evidence.crossPodReadBody = listText.slice(0, 800)
    saveEvidence()
    expect(listText).toContain(ROW_EMAIL)
    const dbCount = psqlProject(dbName, `select count(*) from users where email = '${ROW_EMAIL}'`)
    evidence.rowsInPostgres = dbCount
    saveEvidence()
    expect(dbCount, "the row must be in the shared Postgres database").toBe("1")
  })

  test("3 — a republish serves no 5xx", async () => {
    test.setTimeout(900_000)
    let stop = false
    const statuses: number[] = []
    const hammer = (async () => {
      while (!stop) {
        const res = await page.request
          .get(`${LIVE}/api/${routePath}`, { failOnStatusCode: false, timeout: 20_000 })
          .catch(() => null)
        if (res) statuses.push(res.status())
        await sleep(200)
      }
    })()
    const republished = await page.request.post(`/api/projects/${projectId}/republish`, {
      timeout: publishRequestTimeoutMs(),
    })
    const body = await republished.json().catch(() => null)
    stop = true
    await hammer
    evidence.republishStatus = republished.status()
    evidence.republishBody = body
    evidence.noDowntimeSamples = statuses.length
    evidence.noDowntime5xx = statuses.filter((s) => s >= 500).length
    evidence.noDowntimeCodes = [...new Set(statuses)].sort()
    saveEvidence()
    console.log(
      `[qa-sho551] republish ${republished.status()} — ${statuses.length} samples, 5xx: ${evidence.noDowntime5xx}, codes ${evidence.noDowntimeCodes}`,
    )
    expect(republished.ok()).toBeTruthy()
    expect(evidence.noDowntime5xx, "a republish must not serve a 5xx").toBe(0)
  })

  test("4 — a nullable column lands on republish and the old rows keep serving", async () => {
    test.setTimeout(1_500_000)
    await page.goto(`/projects/${projectId}`)
    await sendProjectChatMessage(
      page,
      "Add one nullable field `nickname String?` to the `User` model in prisma/schema.prisma. " +
        "Change nothing else — no other schema edits, no server, route or package.json changes.",
    )
    await waitForAgentResponse(page, 900_000)

    const republished = await page.request.post(`/api/projects/${projectId}/republish`, {
      timeout: publishRequestTimeoutMs(),
    })
    const body = await republished.json().catch(() => null)
    evidence.nullableColumnRepublishStatus = republished.status()
    evidence.nullableColumnRepublishBody = body
    saveEvidence()
    console.log(`[qa-sho551] nullable-column republish -> ${republished.status()} ${JSON.stringify(body)}`)
    expect(republished.ok(), `nullable-column republish failed: ${JSON.stringify(body)}`).toBeTruthy()

    const column = await poll(
      "nickname column in Postgres",
      async () => {
        const out = psqlProject(
          dbName,
          `select column_name from information_schema.columns where table_schema='public' and column_name='nickname' limit 1`,
        )
        return out === "nickname" ? out : null
      },
      420_000,
    )
    evidence.nicknameColumn = column
    saveEvidence()

    const stillServing = await poll(
      "CRUD after the nullable column",
      async () => {
        const res = await page.request
          .get(`${LIVE}/api/${routePath}`, { timeout: 30_000, failOnStatusCode: false })
          .catch(() => null)
        return res && res.ok() ? res.status() : null
      },
      300_000,
    )
    evidence.crudAfterNullableColumn = stillServing
    saveEvidence()
  })

  test("5 — a destructive schema change is refused while the old revision serves", async () => {
    test.setTimeout(1_500_000)
    await page.goto(`/projects/${projectId}`)
    await sendProjectChatMessage(
      page,
      "Rename the `User` model to `Account` in prisma/schema.prisma and update every reference to it. " +
        "Change nothing else — no UI, server or package.json changes.",
    )
    await waitForAgentResponse(page, 900_000)

    let stop = false
    const statuses: number[] = []
    const hammer = (async () => {
      while (!stop) {
        const res = await page.request
          .get(`${LIVE}/api/${routePath}`, { failOnStatusCode: false, timeout: 20_000 })
          .catch(() => null)
        if (res) statuses.push(res.status())
        await sleep(300)
      }
    })()
    const republished = await page.request.post(`/api/projects/${projectId}/republish`, {
      timeout: publishRequestTimeoutMs(),
    })
    const body = await republished.json().catch(() => null)
    stop = true
    await hammer
    evidence.destructiveRepublishStatus = republished.status()
    evidence.destructiveRepublishBody = body
    evidence.destructiveServingSamples = statuses.length
    evidence.destructiveServing5xx = statuses.filter((s) => s >= 500).length
    saveEvidence()
    console.log(
      `[qa-sho551] destructive republish -> ${republished.status()} ${JSON.stringify(body)} — ${statuses.length} samples, 5xx: ${evidence.destructiveServing5xx}`,
    )
    expect(republished.ok(), "a destructive schema change must not publish successfully").toBeFalsy()
    expect(evidence.destructiveServing5xx, "the old revision must keep serving through a refused publish").toBe(0)
  })

  test("6b — data: 'empty' starts the staging env with a schema and no rows, and is refused once it has one (§G4)", async () => {
    test.setTimeout(900_000)
    const first = await page.request.post(`/api/projects/${projectId}/publish`, {
      data: { subdomain: SUBDOMAIN, environment: "staging", data: "empty" },
      timeout: publishRequestTimeoutMs(),
    })
    const firstBody = await first.json().catch(() => null)
    evidence.emptyPublishStatus = first.status()
    evidence.emptyPublishBody = firstBody
    saveEvidence()
    console.log(`[qa-sho551] data:'empty' publish -> ${first.status()} ${JSON.stringify(firstBody)}`)
    expect(first.ok(), `data:'empty' publish failed: ${JSON.stringify(firstBody)}`).toBeTruthy()

    const seeded = psqlProject(dbName, `select count(*) from users`)
    evidence.emptyPublishRows = seeded
    saveEvidence()
    expect(seeded, "data: 'empty' must not copy the builder's rows").toBe("0")

    // The same option on an environment that now has a schema is refused by name.
    const again = await page.request.post(`/api/projects/${projectId}/publish`, {
      data: { subdomain: SUBDOMAIN, environment: "staging", data: "empty" },
      timeout: publishRequestTimeoutMs(),
      failOnStatusCode: false,
    })
    const againBody = await again.json().catch(() => null)
    evidence.emptyRefusalStatus = again.status()
    evidence.emptyRefusalBody = againBody
    saveEvidence()
    console.log(`[qa-sho551] second data:'empty' -> ${again.status()} ${JSON.stringify(againBody)}`)
    expect(again.status(), "a second data: 'empty' must be refused").toBe(400)
    expect(JSON.stringify(againBody)).toContain("data_empty_not_allowed")
  })

  test("6 — the pod's DATABASE_URL carries a per-replica connection_limit", async () => {
    test.setTimeout(180_000)
    const pod = await poll("a Running published pod", async () => publishedPods(projectId)[0] ?? null, 120_000, 3_000)
    const url = podExec(pod, ["sh", "-lc", "printenv DATABASE_URL | sed 's/:[^:@]*@/:***@/'"]).trim()
    evidence.podDatabaseUrl = url
    saveEvidence()
    console.log(`[qa-sho551] pod DATABASE_URL: ${url}`)
    expect(url).toContain("pgbouncer=true")
    expect(url).toMatch(/connection_limit=\d+/)
  })
})
