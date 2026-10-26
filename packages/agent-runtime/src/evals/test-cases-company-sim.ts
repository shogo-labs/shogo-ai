// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Company simulation: do boards and card history make department agents
 * better at real work? Each scenario runs in three arms (A boards + history,
 * B chat only, C boards without history); see company-sim/report.ts for the
 * ablation.
 *
 *   bun run src/evals/run-eval.ts --track company-sim --model claude-haiku-5-5
 *   bun run src/evals/run-eval.ts --track company-sim --tags arm-a
 */
import type { AgentEval } from './types'
import { COMPANY_SIM_SCENARIOS } from './company-sim/scenarios'
import { scenarioEvals } from './company-sim/scenario'

export const COMPANY_SIM_EVALS: AgentEval[] = COMPANY_SIM_SCENARIOS.flatMap((sc) => scenarioEvals(sc))
