// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { workspaceExperience, type WorkspaceExperience } from '@shogo/shared-app'
import { useActiveWorkspace } from './useActiveWorkspace'

/**
 * The single hook every mobile surface should use to decide what varies
 * between workspace shells (sidebar nav, bottom tabs, home route, composer
 * capabilities, ...) instead of reading `workspace?.kind === 'personal'`
 * ad-hoc. See `workspaceExperience()` in `@shogo/shared-app` for the
 * descriptor and rationale.
 *
 */
export function useWorkspaceExperience(): WorkspaceExperience {
  const workspace = useActiveWorkspace()
  const rawKind = (workspace as { kind?: string } | null)?.kind
  return useMemo(
    () => workspaceExperience(rawKind),
    [rawKind],
  )
}
