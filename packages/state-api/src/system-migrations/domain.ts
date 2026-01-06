/**
 * System Migrations Domain Store
 *
 * Uses the domain() composition API to define MigrationRecord entity for
 * tracking applied database migrations. This is a bootstrap schema that
 * must be initialized before other migrations can be tracked.
 *
 * CollectionPersistable is auto-composed by domain().
 */

import { scope } from "arktype"
import { domain } from "../domain"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const SystemMigrationsDomain = scope({
  MigrationRecord: {
    id: "string.uuid",
    schemaName: "string", // Name of the schema that was migrated
    version: "number", // Schema version number after migration (stored as number, maps to integer)
    checksum: "string", // Hash of schema content for drift detection
    appliedAt: "number", // Unix timestamp when migration was applied
    "statements?": "string[]", // SQL statements executed in this migration
    success: "boolean", // Whether migration completed successfully
    "errorMessage?": "string", // Error message if migration failed
  },
})

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * System Migrations domain with all enhancements.
 * This is a bootstrap schema - it gets initialized before other schemas.
 */
export const systemMigrationsDomain = domain({
  name: "system-migrations",
  from: SystemMigrationsDomain,
  enhancements: {
    // --------------------------------------------------------
    // collections: Add query methods (CollectionPersistable auto-composed)
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      MigrationRecordCollection: collections.MigrationRecordCollection.views((self: any) => ({
        /**
         * Get all migrations for a specific schema, ordered by version
         */
        forSchema(schemaName: string): any[] {
          return self
            .all()
            .filter((r: any) => r.schemaName === schemaName)
            .sort((a: any, b: any) => a.version - b.version)
        },

        /**
         * Get the latest migration for a schema
         */
        latestForSchema(schemaName: string): any | undefined {
          const migrations = self
            .all()
            .filter((r: any) => r.schemaName === schemaName)
            .sort((a: any, b: any) => b.version - a.version)
          return migrations[0]
        },

        /**
         * Check if a specific version has been applied
         */
        hasVersion(schemaName: string, version: number): boolean {
          return self.all().some(
            (r: any) => r.schemaName === schemaName && r.version === version
          )
        },

        /**
         * Get all successful migrations
         */
        successful(): any[] {
          return self.all().filter((r: any) => r.success)
        },

        /**
         * Get all failed migrations
         */
        failed(): any[] {
          return self.all().filter((r: any) => !r.success)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions
    // --------------------------------------------------------
    rootStore: (store) =>
      store.actions((self: any) => ({
        /**
         * Record a successful migration
         */
        recordSuccess(
          schemaName: string,
          version: number,
          checksum: string,
          statements: string[]
        ): any {
          const record = {
            id: crypto.randomUUID(),
            schemaName,
            version,
            checksum,
            appliedAt: Date.now(),
            statements,
            success: true,
          }
          self.migrationRecordCollection.add(record)
          return record
        },

        /**
         * Record a failed migration
         */
        recordFailure(
          schemaName: string,
          version: number,
          checksum: string,
          statements: string[],
          errorMessage: string
        ): any {
          const record = {
            id: crypto.randomUUID(),
            schemaName,
            version,
            checksum,
            appliedAt: Date.now(),
            statements,
            success: false,
            errorMessage,
          }
          self.migrationRecordCollection.add(record)
          return record
        },
      })),
  },
})
