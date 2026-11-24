// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The app's spinner. One implementation lives in @shogo/shared-ui so the mobile
 * app and the shared screens cannot drift apart; it paints from theme tokens so
 * the accent and light/dark mode always apply.
 *
 * Imported through its own `@shogo/shared-ui/spinner` subpath (not the
 * primitives barrel) so RTL suites that stub `@shogo/shared-ui/primitives` down
 * to `cn` still get a real spinner instead of a missing export.
 */
export { Spinner, type SpinnerProps, type SpinnerTone } from '@shogo/shared-ui/spinner'
