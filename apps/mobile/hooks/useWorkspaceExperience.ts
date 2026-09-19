// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { workspaceExperience, type WorkspaceExperience } from '@shogo/shared-app'
import { useActiveWorkspace } from './useActiveWorkspace'
import { usePlatformConfig } from '../lib/platform-config'

/**
 * The single hook every mobile surface should use to decide what varies
 * between the personal and team workspace shells (sidebar nav, bottom tabs,
 * home route, composer capabilities, ...) — instead of reading
 * `workspace?.kind === 'personal'` ad-hoc. See `workspaceExperience()` in
 * `@shogo/shared-app` for the full descriptor and rationale.
 *
 * Honors the server-issued `personalShell` kill switch (`/api/config`): when
 * off, every personal workspace is described as `team` so the whole shell
 * (home, nav, composer) degrades consistently rather than just the home
 * route, in case the companion-shell rollout needs to pause instance-wide.
 */
export function useWorkspaceExperience(): WorkspaceExperience {
  const workspace = useActiveWorkspace()
  const { features } = usePlatformConfig()
  const rawKind = (workspace as { kind?: string } | null)?.kind
  const kind = rawKind === 'personal' && !features.personalShell ? 'team' : rawKind
  return useMemo(() => workspaceExperience(kind), [kind])
}
