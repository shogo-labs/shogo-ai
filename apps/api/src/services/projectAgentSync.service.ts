// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reconciliation engine for `POST /api/projects/:id/agents/sync`.
 *
 * Diffs a manifest (`Record<string, AgentManifest>`) against the
 * project's existing `project_agents` rows and applies the
 * difference. Voice-capable agents (manifest has `voiceId`) are
 * additionally provisioned / patched / deleted in ElevenLabs.
 *
 * Semantics:
 *   - **create**: name appears in manifest, no row exists. If
 *     `voiceId` is set we also call EL.createAgent and persist the
 *     returned id.
 *   - **update**: name appears in both. We diff the manifest fields
 *     against the row; any change → DB update + (when an EL agent id
 *     is involved) EL.patchAgent. A row that was previously chat-only
 *     can become voice-capable: if `voiceId` lands and no agent id is
 *     stored, we EL.createAgent and persist.
 *   - **delete (prune-only)**: name in row but not manifest, AND
 *     `prune === true`, AND `name !== 'default'`. EL agent is
 *     deleted best-effort; row is dropped. The `default` agent is
 *     never pruned because legacy projects still rely on it.
 *
 * `dryRun === true` short-circuits all writes and returns the same
 * diff shape with `dryRun: true`. The CLI uses this to preview.
 */

import { ElevenLabsClient, type ConvaiClientTool } from '@shogo-ai/sdk/voice'
import { prisma } from '../lib/prisma'

/**
 * Normalized tool descriptor — what the wire payload + the
 * `project_agents.tools` column store. String sugar on the CLI side is
 * always expanded before reaching the service.
 */
export interface ToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface AgentManifestEntry {
  systemPrompt?: string | null
  /**
   * Tool descriptors. Source of truth as of v1.6 — replaces the
   * legacy `toolsAllowlist: string[]`. Server still accepts the old
   * shape on the wire for one release window (auto-promoted to
   * `[{ name }]`) so older CLI versions don't break.
   */
  tools?: ToolDescriptor[] | null
  characterName?: string | null
  displayName?: string | null
  voiceId?: string | null
  firstMessage?: string | null
  model?: string | null
}

export interface SyncProjectAgentsParams {
  projectId: string
  workspaceId: string
  manifest: Record<string, unknown>
  prune: boolean
  dryRun: boolean
  /**
   * Resolved ElevenLabs client. May be `null` when the env doesn't
   * have `ELEVENLABS_API_KEY` set — voice-bearing manifest entries
   * will then collect an error rather than silently being persisted
   * as chat-only.
   */
  elClient: ElevenLabsClient | null
}

export interface SyncProjectAgentsResult {
  created: string[]
  updated: string[]
  deleted: string[]
  errors: Array<{ name: string; message: string }>
  dryRun: boolean
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

function asNullableString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v === 'string') return v.length === 0 ? null : v
  return undefined
}

/**
 * Coerce arbitrary wire input into a normalized `ToolDescriptor[]`.
 *
 * Three accepted shapes:
 *   - `string[]`           — legacy `toolsAllowlist`; expanded to `[{ name }]`
 *   - `ToolDescriptor[]`   — current canonical form
 *   - mixed                — older CLI versions can ship either
 *
 * Returns `undefined` (no change) when input is `undefined`, `null` to
 * clear the field, or a normalized array otherwise. Invalid entries
 * (missing `name`, non-object) are silently dropped — the CLI
 * validator already errored on them.
 */
function asToolDescriptorArray(
  v: unknown,
): ToolDescriptor[] | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (!Array.isArray(v)) return undefined
  const out: ToolDescriptor[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (typeof x === 'string') {
      if (x.length === 0 || seen.has(x)) continue
      seen.add(x)
      out.push({ name: x })
      continue
    }
    if (x == null || typeof x !== 'object' || Array.isArray(x)) continue
    const obj = x as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : null
    if (!name || name.length === 0 || seen.has(name)) continue
    seen.add(name)
    const d: ToolDescriptor = { name }
    if (typeof obj.description === 'string') d.description = obj.description
    if (
      obj.inputSchema !== null &&
      typeof obj.inputSchema === 'object' &&
      !Array.isArray(obj.inputSchema)
    ) {
      d.inputSchema = obj.inputSchema as Record<string, unknown>
    }
    out.push(d)
  }
  return out
}

/** Decode a `tools` JSON value as stored — Postgres JSONB or SQLite string. */
function decodeStoredTools(raw: unknown): ToolDescriptor[] | null {
  if (raw == null) return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  return asToolDescriptorArray(parsed) ?? null
}

/** Deep-equal check for tool descriptors. Order-sensitive. */
function toolsEqual(
  a: ToolDescriptor[] | null,
  b: ToolDescriptor[] | null,
): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.name !== y.name) return false
    if ((x.description ?? null) !== (y.description ?? null)) return false
    const xs = x.inputSchema ? JSON.stringify(x.inputSchema) : null
    const ys = y.inputSchema ? JSON.stringify(y.inputSchema) : null
    if (xs !== ys) return false
  }
  return true
}

/**
 * Convert a normalized `ToolDescriptor[]` into the EL convai
 * `prompt.tools` shape. EL expects:
 *   `{ type: 'client', name, description, parameters?, expects_response? }`
 *
 * Tools missing a `description` get a synthesized empty string — EL
 * rejects null. Tools missing an `inputSchema` are sent without
 * `parameters`, which means the model knows the tool exists but can't
 * pass arguments to it.
 */
export function toConvaiTools(
  tools: ToolDescriptor[],
): ReadonlyArray<ConvaiClientTool> {
  return tools.map((t) => {
    const tool: ConvaiClientTool = {
      type: 'client',
      name: t.name,
      description: t.description ?? '',
    }
    if (t.inputSchema) tool.parameters = t.inputSchema
    return tool
  })
}

/**
 * Coerce one entry from the wire body into a strict
 * `AgentManifestEntry`. Unknown fields are ignored. Returns an array
 * of validation errors (empty when valid).
 */
function parseManifestEntry(name: string, raw: unknown): {
  entry: AgentManifestEntry
  errors: string[]
} {
  const errors: string[] = []
  if (!NAME_PATTERN.test(name)) {
    errors.push(
      `agent name '${name}' must match /^[a-z][a-z0-9_-]{0,63}$/`,
    )
  }
  if (!raw || typeof raw !== 'object') {
    errors.push(`agent '${name}' value must be an object`)
    return { entry: {}, errors }
  }
  const r = raw as Record<string, unknown>
  const entry: AgentManifestEntry = {}
  const sp = asNullableString(r.systemPrompt)
  if (sp !== undefined) entry.systemPrompt = sp
  const cn = asNullableString(r.characterName)
  if (cn !== undefined) entry.characterName = cn
  const dn = asNullableString(r.displayName)
  if (dn !== undefined) entry.displayName = dn
  const vid = asNullableString(r.voiceId)
  if (vid !== undefined) entry.voiceId = vid
  const fm = asNullableString(r.firstMessage)
  if (fm !== undefined) entry.firstMessage = fm
  const md = asNullableString(r.model)
  if (md !== undefined) entry.model = md
  // Accept both `tools` (canonical) and the legacy `toolsAllowlist`
  // string[] from older CLI versions. Both end up normalized to
  // `ToolDescriptor[]`.
  const tools = asToolDescriptorArray(r.tools ?? r.toolsAllowlist)
  if (tools !== undefined) entry.tools = tools

  if (entry.voiceId && !entry.firstMessage) {
    // Don't fail — EL accepts an empty firstMessage — but warn the
    // CLI so the deploy output flags this. Surfaced as a non-blocking
    // entry in `errors` keyed under the agent name.
    errors.push(
      `agent '${name}' has voiceId but no firstMessage; using empty greeting`,
    )
  }

  return { entry, errors }
}

/**
 * Compute the field-level diff between a manifest entry and a stored
 * row. Returns the patch object to apply to the row (Prisma update
 * data shape) and a boolean for whether the EL agent needs patching.
 */
function diffManifestVsRow(
  entry: AgentManifestEntry,
  row: {
    systemPrompt: string | null
    toolsAllowlist: unknown
    tools: unknown
    characterName: string | null
    displayName: string | null
    voiceId: string | null
    firstMessage: string | null
    model: string | null
  },
): { patch: Record<string, unknown>; needsElPatch: boolean } {
  const patch: Record<string, unknown> = {}
  let needsElPatch = false

  if (entry.systemPrompt !== undefined && entry.systemPrompt !== row.systemPrompt) {
    patch.systemPrompt = entry.systemPrompt
    needsElPatch = true
  }
  if (entry.characterName !== undefined && entry.characterName !== row.characterName) {
    patch.characterName = entry.characterName
    needsElPatch = true
  }
  if (entry.displayName !== undefined && entry.displayName !== row.displayName) {
    patch.displayName = entry.displayName
    needsElPatch = true
  }
  if (entry.voiceId !== undefined && entry.voiceId !== row.voiceId) {
    patch.voiceId = entry.voiceId
    needsElPatch = true
  }
  if (entry.firstMessage !== undefined && entry.firstMessage !== row.firstMessage) {
    patch.firstMessage = entry.firstMessage
    needsElPatch = true
  }
  if (entry.model !== undefined && entry.model !== row.model) {
    patch.model = entry.model
    // Model is chat-only; no EL patch required.
  }

  if (entry.tools !== undefined) {
    // Prefer the new `tools` column; fall back to the legacy
    // `toolsAllowlist` for rows written before the structured tools
    // migration ran.
    const stored =
      decodeStoredTools(row.tools) ?? decodeStoredTools(row.toolsAllowlist)
    const next = entry.tools ?? null
    if (!toolsEqual(stored, next)) {
      patch.tools = next
      // Tool changes must be reflected in EL — the convai agent
      // exposes them as client tools to the model.
      needsElPatch = true
    }
  }

  return { patch, needsElPatch }
}

export async function syncProjectAgents(
  params: SyncProjectAgentsParams,
): Promise<SyncProjectAgentsResult> {
  const result: SyncProjectAgentsResult = {
    created: [],
    updated: [],
    deleted: [],
    errors: [],
    dryRun: params.dryRun,
  }

  const parsedEntries = new Map<string, AgentManifestEntry>()
  for (const [name, raw] of Object.entries(params.manifest)) {
    const { entry, errors } = parseManifestEntry(name, raw)
    if (errors.length > 0) {
      for (const m of errors) result.errors.push({ name, message: m })
    }
    if (NAME_PATTERN.test(name)) {
      parsedEntries.set(name, entry)
    }
  }

  const existingRows = await prisma.projectAgent.findMany({
    where: { projectId: params.projectId },
  })
  const existingByName = new Map(existingRows.map((r) => [r.name, r]))

  // CREATE / UPDATE
  for (const [name, entry] of parsedEntries) {
    const existing = existingByName.get(name)
    try {
      if (!existing) {
        let elAgentId: string | null = null
        if (entry.voiceId) {
          if (!params.elClient) {
            result.errors.push({
              name,
              message:
                'ELEVENLABS_API_KEY is not configured; voice-bearing agent could not be provisioned. Row will be persisted without an EL agent id.',
            })
          } else if (!params.dryRun) {
            elAgentId = await params.elClient.createAgent({
              displayName:
                entry.displayName ??
                `shogo-project-${params.projectId.slice(0, 8)}-${name}`,
              characterName: entry.characterName ?? 'Shogo',
              voiceId: entry.voiceId,
              systemPrompt: entry.systemPrompt ?? '',
              firstMessage: entry.firstMessage ?? '',
              memoryBlock: null,
              language: 'en',
              ...(entry.tools && entry.tools.length > 0
                ? { tools: toConvaiTools(entry.tools) }
                : {}),
            })
          }
        }
        if (!params.dryRun) {
          await prisma.projectAgent.create({
            data: {
              projectId: params.projectId,
              workspaceId: params.workspaceId,
              name,
              systemPrompt: entry.systemPrompt ?? null,
              tools: entry.tools
                ? (entry.tools as unknown as object)
                : undefined,
              characterName: entry.characterName ?? null,
              displayName: entry.displayName ?? null,
              voiceId: entry.voiceId ?? null,
              firstMessage: entry.firstMessage ?? null,
              elevenlabsAgentId: elAgentId,
              model: entry.model ?? null,
            },
          })
        }
        result.created.push(name)
        continue
      }

      // UPDATE branch.
      const { patch, needsElPatch } = diffManifestVsRow(entry, existing)
      const existingHasElAgent = !!existing.elevenlabsAgentId
      // Promotion: chat-only row gains a voiceId on this deploy.
      const isPromotionToVoice =
        entry.voiceId !== undefined &&
        entry.voiceId !== null &&
        !existingHasElAgent
      const noChange = Object.keys(patch).length === 0 && !isPromotionToVoice
      if (noChange) continue

      let nextElAgentId: string | null | undefined = undefined
      if (isPromotionToVoice && params.elClient && !params.dryRun) {
        // Resolve the effective tools for the new EL agent: prefer the
        // manifest's tools (entry.tools), then the row's stored tools,
        // then nothing.
        const promotionTools =
          entry.tools ??
          decodeStoredTools(existing.tools) ??
          decodeStoredTools(existing.toolsAllowlist) ??
          null
        nextElAgentId = await params.elClient.createAgent({
          displayName:
            entry.displayName ??
            existing.displayName ??
            `shogo-project-${params.projectId.slice(0, 8)}-${name}`,
          characterName: entry.characterName ?? existing.characterName ?? 'Shogo',
          voiceId: entry.voiceId!,
          systemPrompt: entry.systemPrompt ?? existing.systemPrompt ?? '',
          firstMessage: entry.firstMessage ?? existing.firstMessage ?? '',
          memoryBlock: null,
          language: 'en',
          ...(promotionTools && promotionTools.length > 0
            ? { tools: toConvaiTools(promotionTools) }
            : {}),
        })
      } else if (
        existingHasElAgent &&
        needsElPatch &&
        params.elClient &&
        !params.dryRun
      ) {
        // Only forward to EL the fields that actually changed — keys
        // come from the diff `patch` object, values from the
        // already-validated manifest entry.
        const elPatch: Record<string, unknown> = {}
        if ('systemPrompt' in patch) {
          elPatch.systemPrompt = entry.systemPrompt ?? ''
        }
        if ('firstMessage' in patch) {
          elPatch.firstMessage = entry.firstMessage ?? ''
        }
        if ('voiceId' in patch && entry.voiceId) {
          elPatch.voiceId = entry.voiceId
        }
        if ('characterName' in patch) {
          elPatch.characterName = entry.characterName ?? ''
        }
        if ('displayName' in patch) {
          elPatch.displayName = entry.displayName ?? ''
        }
        if ('tools' in patch && entry.tools) {
          elPatch.tools = toConvaiTools(entry.tools)
        }
        await params.elClient.patchAgent(existing.elevenlabsAgentId!, elPatch)
      }

      if (!params.dryRun) {
        await prisma.projectAgent.update({
          where: { id: existing.id },
          data: {
            ...patch,
            ...(nextElAgentId !== undefined
              ? { elevenlabsAgentId: nextElAgentId }
              : {}),
          },
        })
      }
      result.updated.push(name)
    } catch (err: any) {
      result.errors.push({
        name,
        message: err?.message ?? String(err),
      })
    }
  }

  // DELETE (prune)
  if (params.prune) {
    for (const row of existingRows) {
      if (parsedEntries.has(row.name)) continue
      if (row.name === 'default') continue
      try {
        if (row.elevenlabsAgentId && params.elClient && !params.dryRun) {
          try {
            await params.elClient.deleteAgent(row.elevenlabsAgentId)
          } catch (e: any) {
            // Best-effort: log but continue. EL DELETE is idempotent.
            console.warn(
              `[Agents Sync] EL deleteAgent failed for ${row.name}:`,
              e?.message || e,
            )
          }
        }
        if (!params.dryRun) {
          await prisma.projectAgent.delete({ where: { id: row.id } })
        }
        result.deleted.push(row.name)
      } catch (err: any) {
        result.errors.push({
          name: row.name,
          message: err?.message ?? String(err),
        })
      }
    }
  }

  return result
}
