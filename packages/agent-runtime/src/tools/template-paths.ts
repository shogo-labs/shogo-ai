// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// packages/agent-runtime/src/tools/template-paths.ts -> monorepo root is 4 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const MONOREPO_ROOT = resolve(__dirname, '../../../../')
