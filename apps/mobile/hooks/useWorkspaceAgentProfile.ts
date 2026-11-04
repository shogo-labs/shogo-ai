// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace agent's identity, painted from the device first (SHO-309).
 *
 * The island's name and a side chat's header both used to start empty and wait
 * for `GET …/agent-profile`, so they flashed "Shogo" (or a bare header) before
 * the real name arrived. The workspace chat screen already settles that answer
 * on the device, so these surfaces read it there and revalidate in the
 * background — no extra request, no flash.
 */
import { useEffect, useState } from "react"
import { useAuth } from '../contexts/auth'
import { useDomainHttp } from '../contexts/domain'
import { useActiveInstance } from '../contexts/active-instance'
import { api, type PersonalAgentProfile } from '../lib/api'
import {
  chatHistoryOrigin,
  loadWorkspaceChatBoot,
  peekWorkspaceChatBoot,
  rememberWorkspaceChatBoot,
  workspaceChatBootKey,
} from '../lib/chat-device-boot'

export function useWorkspaceAgentProfile(
  workspaceId: string | undefined,
): PersonalAgentProfile | null {
  const http = useDomainHttp()
  const { user } = useAuth()
  const { instance } = useActiveInstance()
  const key = workspaceChatBootKey(
    user?.id,
    chatHistoryOrigin(instance?.instanceId),
    workspaceId,
  )
  // Keyed so a workspace switch never shows the previous agent's name while
  // the next one is resolving.
  const [seeded, setSeeded] = useState<{
    key: string | null
    profile: PersonalAgentProfile | null
  }>(() => ({ key, profile: peekWorkspaceChatBoot<PersonalAgentProfile>(key)?.profile ?? null }))

  useEffect(() => {
    if (!key) {
      setSeeded({ key: null, profile: null })
      return
    }
    let cancelled = false
    const remembered = peekWorkspaceChatBoot<PersonalAgentProfile>(key)
    if (remembered?.profile) setSeeded({ key, profile: remembered.profile })
    void loadWorkspaceChatBoot<PersonalAgentProfile>(key)
      .then((record) => {
        if (cancelled || !record?.profile) return
        setSeeded((current) =>
          current.key === key && current.profile ? current : { key, profile: record.profile },
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [key])

  useEffect(() => {
    if (!workspaceId || !key) return
    let cancelled = false
    void api
      .getAgentProfile(http, workspaceId)
      .then((next) => {
        if (cancelled || !next) return
        setSeeded({ key, profile: next })
        rememberWorkspaceChatBoot<PersonalAgentProfile>(key, { profile: next })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [http, workspaceId, key])

  return seeded.key === key ? seeded.profile : null
}
