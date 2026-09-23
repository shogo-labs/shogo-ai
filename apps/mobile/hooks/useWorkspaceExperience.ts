// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { Platform, useWindowDimensions } from 'react-native'
import { workspaceExperience, type WorkspaceExperience } from '@shogo/shared-app'
import { useActiveWorkspace } from './useActiveWorkspace'
import { WEB_WIDE_MIN_WIDTH } from '../lib/native-phone-layout'

/**
 * The single hook every mobile surface should use to decide what varies
 * between workspace shells (sidebar nav, bottom tabs, home route, composer
 * capabilities, ...) instead of reading `workspace?.kind === 'personal'`
 * ad-hoc. Personal workspaces receive their companion presentation only on
 * narrow/native surfaces; wide web always uses the established builder
 * presentation. See `workspaceExperience()` in `@shogo/shared-app` for the
 * descriptor and rationale.
 *
 */
export function useWorkspaceExperience(): WorkspaceExperience {
  const workspace = useActiveWorkspace()
  const { width } = useWindowDimensions()
  const rawKind = (workspace as { kind?: string } | null)?.kind
  // The companion experience is mobile-only. Wide web surfaces preserve the
  // established builder navigation even for a personal workspace.
  const usesMobileExperience =
    Platform.OS !== 'web' || width < WEB_WIDE_MIN_WIDTH
  const presentationKind = usesMobileExperience ? rawKind : 'team'
  return useMemo(
    () => workspaceExperience(presentationKind),
    [presentationKind],
  )
}
