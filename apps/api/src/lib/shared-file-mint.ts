// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a shared-file link is minted (SHO-486).
 *
 * `share_file` hands the person a URL, and the app opens it. On a paired
 * desktop whose workspace is viewed from the cloud, a locally minted link is
 * wrong twice over: it points at the desktop's loopback address (the app is not
 * there) and it is signed with the desktop's own signing secret (the cloud
 * cannot verify it), so the chip rendered and the download 404'd. The link has
 * to be a cloud origin with a cloud signature.
 *
 * So on a paired desktop the mint is relayed to the cloud, which signs it and
 * serves it through the host tunnel — the file still never leaves this disk.
 * A desktop that is not paired, or a cloud that cannot be reached, keeps the
 * local link: a working link on this machine beats no link at all.
 */

import { getShogoCloudUrl } from './cloud-urls'
import { getUpstreamCredential } from './federated-upstream'

export interface SharedFileMintInput {
  /** The owning project; absent for a workspace-runtime file. */
  projectId?: string
  workspaceId: string
  path: string
  expiresInDays: number
}

export interface SharedFileMint {
  ok: true
  url: string
  expiresAt: string
  path: string
}

export interface SharedFileMintDeps {
  fetchImpl?: typeof fetch
  cloudUrl?: string | null
  apiKey?: string | null
  instanceId?: string | null
  log?: (line: string) => void
}

/**
 * Mint the link on the cloud. `null` means "mint it here instead": this is not a
 * paired desktop, or the cloud did not answer.
 */
export async function mintSharedFileLink(
  input: SharedFileMintInput,
  deps: SharedFileMintDeps = {},
): Promise<SharedFileMint | null> {
  if (process.env.SHOGO_LOCAL_MODE !== 'true') return null
  const log = deps.log ?? ((line: string) => console.warn(line))

  const cloudUrl = deps.cloudUrl !== undefined ? deps.cloudUrl : getShogoCloudUrl()
  if (!cloudUrl) return null
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : await getUpstreamCredential()
  if (!apiKey) return null
  const instanceId =
    deps.instanceId !== undefined
      ? deps.instanceId
      : ((await import('./instance-tunnel')).getInstanceId() ?? process.env.SHOGO_INSTANCE_ID ?? null)
  if (!instanceId) return null

  const fetchImpl = deps.fetchImpl ?? fetch
  const url = `${cloudUrl.replace(/\/+$/, '')}/api/machines/${encodeURIComponent(instanceId)}/shared-files`
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      log(`[SharedFiles] the cloud would not mint a link (${response.status}); using a local one`)
      return null
    }
    const body = (await response.json()) as Partial<SharedFileMint>
    if (typeof body?.url !== 'string' || !body.url) return null
    return {
      ok: true,
      url: body.url,
      expiresAt: String(body.expiresAt ?? ''),
      path: String(body.path ?? input.path),
    }
  } catch (err) {
    log(`[SharedFiles] the cloud mint failed (${(err as Error)?.message ?? err}); using a local one`)
    return null
  }
}
