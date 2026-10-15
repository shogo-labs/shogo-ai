// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace agent setup and management of departments, boards, channels,
 * triggers and capabilities, graded on the live workspace afterwards.
 *
 *   bun run src/evals/run-eval.ts --track company-ops --model claude-haiku-5-5
 */
import type { AgentEval } from './types'
import { opsEvals } from './company-sim/ops-scenarios'

export const COMPANY_OPS_EVALS: AgentEval[] = opsEvals()
