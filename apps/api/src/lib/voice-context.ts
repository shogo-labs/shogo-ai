// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo voice — per-session project + memory context.
 *
 * Both the voice modality (ElevenLabs `overrides.agent.prompt.prompt`)
 * and the text modality (AI-SDK `streamText({ system })`) need the
 * same project metadata + long-lived memory snippets injected into
 * Shogo's persona prompt at session start, so Shogo can answer
 * questions like "what's this app actually called?" or "what did the
 * user ask for last time?" without hallucinating.
 *
 * The technical agent gets this context via its own injection path
 * (workspace files mounted into the runtime pod). Shogo runs outside
 * the pod, so we mirror the relevant bits server-side here:
 *
 *   - Project identity from Postgres (`name`, `description`,
 *     `siteTitle`, `siteDescription`).
 *   - `MEMORY.md` and `USER.md` from the project's runtime pod via
 *     `GET /agent/workspace/files/<path>`, authenticated with a
 *     `x-runtime-token`.
 *
 * Both pod fetches are best-effort: a fresh project may not have a
 * running pod (cold start), or `MEMORY.md`/`USER.md` may not exist
 * yet. We never block voice on memory — if anything fails we just
 * fall back to whatever context we already have.
 */

import { prisma } from './prisma'
import { getProjectPodUrl } from './knative-project-manager'
import { deriveRuntimeToken } from './runtime-token'

/**
 * Per-file size caps on what we paste into Shogo's prompt. The
 * persona prompt itself is already non-trivial; we want plenty of
 * headroom for the actual conversation. Anything beyond the cap is
 * truncated with a "(truncated)" marker so Shogo knows it didn't get
 * the full file.
 *
 * MEMORY.md is the long-lived project memory and tends to be the
 * largest of the three; USER.md is short by convention.
 */
const MEMORY_MD_MAX_BYTES = 4_000
const USER_MD_MAX_BYTES = 2_000

/**
 * Pod fetches must not block voice. If a pod is cold-starting we'd
 * rather ship Shogo with project metadata only than wait 30+ seconds
 * for the runtime to boot.
 */
const POD_FETCH_TIMEOUT_MS = 2_000

/**
 * Truncate a string to `maxBytes` UTF-8 bytes, appending a marker so
 * downstream consumers (and the LLM) know the content was clipped.
 */
function clampBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  // Slice on a byte boundary; some characters may be split, but the
  // resulting string is still valid UTF-8 because Buffer.toString
  // replaces incomplete sequences with U+FFFD.
  const head = buf.subarray(0, maxBytes).toString('utf8')
  return `${head}\n\n…(truncated, original was ${buf.length} bytes)`
}

/**
 * Fetch a single file from the project's runtime pod with a short
 * timeout. Returns `null` for any failure mode — pod cold-start, 404
 * (file doesn't exist), bad JSON, network error, etc. Callers should
 * treat `null` as "no memory available", not as an error.
 *
 * Shaped to match `GET /agent/workspace/files/<path>` from
 * `packages/sdk/src/agent/client.ts`: returns `{ content: string }`.
 */
async function fetchPodFile(params: {
  projectId: string
  podUrl: string
  path: string
  signal?: AbortSignal
}): Promise<string | null> {
  const { projectId, podUrl, path, signal } = params
  const url = `${podUrl.replace(/\/+$/, '')}/agent/workspace/files/${encodeURIComponent(path)}`

  // Layer our own timeout on top of the caller's signal — this
  // guarantees we return promptly even if the pod hangs.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POD_FETCH_TIMEOUT_MS)
  const onUpstreamAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onUpstreamAbort, { once: true })
  }

  try {
    const res = await fetch(url, {
      headers: { 'x-runtime-token': deriveRuntimeToken(projectId) },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { content?: unknown }
    if (typeof body?.content !== 'string') return null
    return body.content
  } catch {
    // Cold start, network error, abort — all benign.
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onUpstreamAbort)
  }
}

/** Project metadata snippet pulled from Postgres. All fields optional. */
type ProjectMetadata = {
  name: string | null
  description: string | null
  siteTitle: string | null
  siteDescription: string | null
}

async function loadProjectMetadata(projectId: string): Promise<ProjectMetadata | null> {
  try {
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        description: true,
        siteTitle: true,
        siteDescription: true,
      },
    })
    if (!row) return null
    return {
      name: row.name ?? null,
      description: row.description ?? null,
      siteTitle: row.siteTitle ?? null,
      siteDescription: row.siteDescription ?? null,
    }
  } catch (err) {
    console.warn(
      '[voice-context] loadProjectMetadata failed:',
      (err as Error)?.message ?? err,
    )
    return null
  }
}

/**
 * Resolve the per-session voice context block for `projectId`.
 *
 * Returns a markdown-formatted string suitable for appending to
 * `TRANSLATOR_SYSTEM_PROMPT`, or `''` if nothing useful was
 * resolved (so callers can collapse the section cleanly).
 *
 * Failure modes:
 *
 *   - Project row not found → returns `''`.
 *   - Pod cold-start / unreachable → project metadata only.
 *   - `MEMORY.md` / `USER.md` missing → those sections omitted.
 *
 * Never throws — this runs on the hot path of every signed-URL mint
 * and translator chat, so it must degrade gracefully.
 */
export async function resolveVoiceContext(params: {
  projectId: string
  signal?: AbortSignal
}): Promise<string> {
  const { projectId, signal } = params

  // 1. Project metadata is cheap (one DB hit).
  const metadata = await loadProjectMetadata(projectId)

  // 2. Pod-resident files in parallel. We fetch the pod URL once and
  // pull both files concurrently — typical pod fetches complete in a
  // few hundred ms when the pod is warm.
  let memory: string | null = null
  let userMd: string | null = null
  try {
    const podUrl = await getProjectPodUrl(projectId)
    const [memoryResult, userResult] = await Promise.all([
      fetchPodFile({ projectId, podUrl, path: 'MEMORY.md', signal }),
      fetchPodFile({ projectId, podUrl, path: 'USER.md', signal }),
    ])
    memory = memoryResult
    userMd = userResult
  } catch (err) {
    // `getProjectPodUrl` may throw on cold-start / no-warm-pod paths.
    // That's fine — fall back to project metadata only.
    console.warn(
      '[voice-context] pod fetch skipped:',
      (err as Error)?.message ?? err,
    )
  }

  return formatContextBlock({ metadata, memory, userMd })
}

/**
 * Compose the markdown block from resolved fragments. Pure function so
 * tests can exercise the formatting without standing up Prisma + a
 * runtime pod.
 */
export function formatContextBlock(params: {
  metadata: ProjectMetadata | null
  memory: string | null
  userMd: string | null
}): string {
  const { metadata, memory, userMd } = params
  const sections: string[] = []

  if (metadata) {
    const lines: string[] = ['## About this project']
    if (metadata.name) lines.push(`Name: ${metadata.name}`)
    const desc = metadata.description ?? metadata.siteDescription
    if (desc) lines.push(`Description: ${desc}`)
    if (metadata.siteTitle && metadata.siteTitle !== metadata.name) {
      lines.push(`Site title: ${metadata.siteTitle}`)
    }
    if (lines.length > 1) sections.push(lines.join('\n'))
  }

  const memoryTrimmed = memory?.trim()
  if (memoryTrimmed) {
    sections.push(
      `## Long-lived memory\n${clampBytes(memoryTrimmed, MEMORY_MD_MAX_BYTES)}`,
    )
  }

  const userMdTrimmed = userMd?.trim()
  if (userMdTrimmed) {
    sections.push(
      `## About this user\n${clampBytes(userMdTrimmed, USER_MD_MAX_BYTES)}`,
    )
  }

  return sections.join('\n\n')
}

// Re-export the prompt composer from the persona module so all voice
// code can `import { resolveVoiceContext, composeVoiceSystemPrompt }`
// from this one file. Keeps consumers from having to know which
// package owns which half of the voice prompt pipeline.
export { composeVoiceSystemPrompt } from '@shogo/agent-runtime/src/voice-mode/translator-persona'
