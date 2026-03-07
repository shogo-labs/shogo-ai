// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
#!/usr/bin/env bun
/**
 * Migration Script: Backfill K8s Secrets for Existing Project Databases
 *
 * This script reads DATABASE_URL from each running Knative Service's pod spec
 * and creates corresponding K8s Secrets so that future ksvc updates can use
 * secretKeyRef instead of inline credentials.
 *
 * Safe to run multiple times (idempotent):
 * - Skips projects that already have a Secret
 * - Reads credentials from existing ksvc spec (doesn't change passwords)
 *
 * Usage:
 *   # Dry run (default) — shows what would be created
 *   bun run scripts/migrate-db-secrets.ts
 *
 *   # Actually create the Secrets
 *   bun run scripts/migrate-db-secrets.ts --apply
 *
 *   # Specify namespace
 *   bun run scripts/migrate-db-secrets.ts --apply --namespace shogo-workspaces
 */

import * as k8s from "@kubernetes/client-node"

// =============================================================================
// Configuration
// =============================================================================

const args = process.argv.slice(2)
const dryRun = !args.includes("--apply")
const namespaceFlag = args.find((a) => a.startsWith("--namespace="))
const NAMESPACE = namespaceFlag
  ? namespaceFlag.split("=")[1]
  : process.env.PROJECT_NAMESPACE || "shogo-workspaces"

const KNATIVE_GROUP = "serving.knative.dev"
const KNATIVE_VERSION = "v1"

// =============================================================================
// K8s Client Setup
// =============================================================================

const kc = new k8s.KubeConfig()
kc.loadFromDefault()
const customApi = kc.makeApiClient(k8s.CustomObjectsApi)
const coreApi = kc.makeApiClient(k8s.CoreV1Api)

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`\n📦 Migrate Database Credentials to K8s Secrets`)
  console.log(`   Namespace: ${NAMESPACE}`)
  console.log(`   Mode: ${dryRun ? "DRY RUN (use --apply to create)" : "APPLY"}\n`)

  // 1. List all Knative Services in the namespace
  const response = await customApi.listNamespacedCustomObject({
    group: KNATIVE_GROUP,
    version: KNATIVE_VERSION,
    namespace: NAMESPACE,
    plural: "services",
  }) as any

  const services = response.items || []
  console.log(`Found ${services.length} Knative Service(s)\n`)

  let created = 0
  let skipped = 0
  let errors = 0

  for (const svc of services) {
    const svcName: string = svc.metadata?.name || "unknown"

    // Extract project ID from service name (format: project-{uuid})
    if (!svcName.startsWith("project-")) {
      console.log(`  ⏭️  ${svcName} — not a project service, skipping`)
      skipped++
      continue
    }
    const projectId = svcName.replace("project-", "")
    const secretName = `project-${projectId}-db-creds`

    // 2. Check if Secret already exists
    try {
      await coreApi.readNamespacedSecret({ name: secretName, namespace: NAMESPACE })
      console.log(`  ✅ ${svcName} — Secret "${secretName}" already exists, skipping`)
      skipped++
      continue
    } catch (err: any) {
      if (err?.code !== 404 && err?.response?.statusCode !== 404) {
        console.error(`  ❌ ${svcName} — error checking Secret:`, err.message)
        errors++
        continue
      }
      // 404 = doesn't exist, continue to create
    }

    // 3. Extract DATABASE_URL from the ksvc spec's container env
    const containers =
      svc.spec?.template?.spec?.containers ||
      svc.spec?.template?.spec?.initContainers ||
      []
    let databaseUrl: string | null = null

    for (const container of containers) {
      for (const envVar of container.env || []) {
        if (envVar.name === "DATABASE_URL" && envVar.value) {
          databaseUrl = envVar.value
          break
        }
        // If it already uses secretKeyRef, the migration is partially done
        if (envVar.name === "DATABASE_URL" && envVar.valueFrom?.secretKeyRef) {
          console.log(`  ✅ ${svcName} — already using secretKeyRef, skipping`)
          databaseUrl = "__secretKeyRef__"
          break
        }
      }
      if (databaseUrl) break
    }

    if (databaseUrl === "__secretKeyRef__") {
      skipped++
      continue
    }

    if (!databaseUrl) {
      console.log(`  ⚠️  ${svcName} — no DATABASE_URL found in env, skipping`)
      skipped++
      continue
    }

    // 4. Parse credentials from the URL
    // Format: postgres://username:password@host:port/dbname
    const match = databaseUrl.match(
      /^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/
    )
    if (!match) {
      console.log(`  ⚠️  ${svcName} — could not parse DATABASE_URL, skipping`)
      skipped++
      continue
    }

    const [, username, password, , , ] = match

    if (!password || password === "") {
      console.log(`  ⚠️  ${svcName} — empty password in DATABASE_URL, skipping`)
      skipped++
      continue
    }

    // 5. Create the Secret
    if (dryRun) {
      console.log(`  🔍 ${svcName} — would create Secret "${secretName}" (user: ${username}, password: ${password.substring(0, 4)}...)`)
      created++
    } else {
      try {
        const secretBody: k8s.V1Secret = {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: secretName,
            namespace: NAMESPACE,
            labels: {
              "app.kubernetes.io/managed-by": "shogo-database-service",
              "shogo.ai/project-id": projectId,
              "shogo.ai/component": "database-credentials",
            },
          },
          type: "Opaque",
          stringData: {
            "database-url": databaseUrl,
            username,
            password,
          },
        }
        await coreApi.createNamespacedSecret({ namespace: NAMESPACE, body: secretBody })
        console.log(`  ✅ ${svcName} — created Secret "${secretName}"`)
        created++
      } catch (err: any) {
        console.error(`  ❌ ${svcName} — failed to create Secret:`, err.message)
        errors++
      }
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`  Created: ${created}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Errors:  ${errors}`)
  if (dryRun) {
    console.log(`\n  This was a DRY RUN. Run with --apply to create the Secrets.`)
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
