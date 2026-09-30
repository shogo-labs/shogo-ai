// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from "react"
import {
  useMountedIslandSession,
  useOwnedIslandSession,
  type IslandChatSession,
  type IslandSessionContext,
} from "./useIslandChatSession"
import type { IslandAttachment, IslandFileRef, IslandSession } from "./types"

export interface IslandInitialSend {
  text: string
  files?: IslandFileRef[]
  attachments?: IslandAttachment[]
}

interface HostProps {
  context: IslandSessionContext
  children: (session: IslandChatSession) => ReactNode
}

function MountedHost({ context, live, children }: HostProps & { live: IslandSession }) {
  return <>{children(useMountedIslandSession(context, live))}</>
}

function OwnedHost({
  context,
  initialSend,
  children,
}: HostProps & { initialSend?: IslandInitialSend | null }) {
  return <>{children(useOwnedIslandSession(context, initialSend))}</>
}

/** Picks the session's single owner; see useIslandChatSession. The two hosts
 * are different component types, so a handoff unmounts one before the other
 * mounts. */
export function IslandChatHost({
  context,
  live,
  initialSend,
  children,
}: HostProps & { live: IslandSession | undefined; initialSend?: IslandInitialSend | null }) {
  const key = `${context.projectId}:${context.sessionId}`
  return live ? (
    <MountedHost key={key} context={context} live={live}>
      {children}
    </MountedHost>
  ) : (
    <OwnedHost key={key} context={context} initialSend={initialSend}>
      {children}
    </OwnedHost>
  )
}
