// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * /auth/* layout
 *
 * Routes under `/auth/*` (e.g. `/auth/local-link`) are cloud-side bridge
 * pages that the desktop/other apps open in the system browser. They need
 * the SDK domain (HttpClient + MST store) to hit the cloud API — but they
 * must NOT inherit the `(app)` shell (sidebar, header, VM banner, etc.).
 *
 * This layout therefore mounts `DomainProvider` and renders a bare `<Slot />`.
 * AuthProvider is already mounted at the root (`apps/mobile/app/_layout.tsx`),
 * so the bridge page can call `useAuth()` and redirect unauthenticated users
 * to `/(auth)/sign-in` itself.
 */

import { Slot } from 'expo-router'
import { DomainProvider } from '../../contexts/domain'

export default function AuthBridgeLayout() {
  return (
    <DomainProvider>
      <Slot />
    </DomainProvider>
  )
}
