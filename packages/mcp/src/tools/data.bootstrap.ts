import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getRuntimeStore, getMetaStore, bootstrapStudioCore, getBootstrapData } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  "userId?": "string",
  "workspace?": "string",
  "linkFeatureSessions?": "boolean"
})

/**
 * Bootstrap studio-core with initial data and optionally link FeatureSessions.
 *
 * This tool:
 * 1. Loads studio-core schema if not already loaded
 * 2. Creates Shogo organization, shogo-platform project, and owner member
 * 3. Optionally links existing FeatureSessions to the project
 * 4. Returns created entities
 *
 * Can be run idempotently - checks for existing data before creating.
 *
 * Example usage:
 * ```
 * // Bootstrap with default user
 * await data.bootstrap({})
 *
 * // Bootstrap with specific user and link feature sessions
 * await data.bootstrap({
 *   userId: "auth-user-123",
 *   linkFeatureSessions: true
 * })
 * ```
 */
export function registerDataBootstrap(server: FastMCP) {
  server.addTool({
    name: "data.bootstrap",
    description: "Bootstrap studio-core with initial data (organization, project, member) and optionally link FeatureSessions",
    parameters: Params,
    execute: async (args: any) => {
      const {
        userId = "bootstrap-user",
        workspace,
        linkFeatureSessions = false
      } = args as {
        userId?: string
        workspace?: string
        linkFeatureSessions?: boolean
      }

      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        // 1. Load studio-core schema if not already loaded
        const metaStore = getMetaStore()
        let studioCoreSchema = metaStore.findSchemaByName("studio-core")

        if (!studioCoreSchema) {
          // Schema not loaded - need to load it first
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_NOT_LOADED",
              message: "studio-core schema must be loaded first. Call schema.load({ name: 'studio-core' })"
            }
          })
        }

        // 2. Get runtime store
        const studioCoreStore = getRuntimeStore(studioCoreSchema.id, effectiveWorkspace)
        if (!studioCoreStore) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "RUNTIME_STORE_NOT_FOUND",
              message: "studio-core runtime store not found. Call schema.load({ name: 'studio-core' })"
            }
          })
        }

        // 3. Bootstrap studio-core
        const result = bootstrapStudioCore(studioCoreStore, userId)

        // 4. Optionally link FeatureSessions
        let featureSessionsUpdated = 0
        if (linkFeatureSessions && !result.alreadyBootstrapped) {
          // Load platform-features schema if needed
          let platformFeaturesSchema = metaStore.findSchemaByName("platform-features")

          if (platformFeaturesSchema) {
            const platformStore = getRuntimeStore(platformFeaturesSchema.id, effectiveWorkspace)

            if (platformStore && platformStore.featureSessionCollection) {
              // Find sessions without project
              const sessions = platformStore.featureSessionCollection.all()
              const projectId = result.project.id

              for (const session of sessions) {
                if (!session.project) {
                  session.project = projectId
                  featureSessionsUpdated++
                }
              }
            }
          }
        }

        // 5. Build response
        const bootstrapData = getBootstrapData(studioCoreStore)

        return JSON.stringify({
          ok: true,
          alreadyBootstrapped: result.alreadyBootstrapped,
          organization: {
            id: result.organization.id,
            name: result.organization.name,
            slug: result.organization.slug,
            description: result.organization.description
          },
          project: {
            id: result.project.id,
            name: result.project.name,
            tier: result.project.tier,
            status: result.project.status,
            schemas: result.project.schemas
          },
          member: result.member ? {
            id: result.member.id,
            userId: result.member.userId,
            role: result.member.role
          } : undefined,
          featureSessionsUpdated: linkFeatureSessions ? featureSessionsUpdated : undefined,
          message: result.alreadyBootstrapped
            ? "Bootstrap already complete"
            : `Created organization '${result.organization.name}' and project '${result.project.name}'`
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "BOOTSTRAP_ERROR",
            message: error.message || "Failed to bootstrap studio-core"
          }
        })
      }
    }
  })
}
