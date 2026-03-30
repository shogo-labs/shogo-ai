// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reflection prompt builder for the self-improving eval harness.
 *
 * After each iteration of tasks, this builds a structured analysis
 * of all outcomes — both correct and wrong — and instructs the agent
 * to create/update skill files. Correct outcomes include tool traces
 * so the agent can preserve working strategies and avoid regressions.
 */

export interface ToolStep {
  tool: string
  input: string
  durationMs?: number
  error?: boolean
}

export interface TaskOutcome {
  task_id: string
  level: number
  question: string
  predicted_answer: string
  gold_answer: string
  correct: boolean
  toolCalls: number
  toolTrace?: ToolStep[]
  error?: string
}

export interface IterationStats {
  iteration: number
  total: number
  correct: number
  byLevel: Array<{ level: number; total: number; correct: number }>
}

function formatToolTrace(trace: ToolStep[]): string {
  if (!trace || trace.length === 0) return '  _(no tool calls)_'
  return trace.map(s => {
    const status = s.error ? 'ERR' : 'OK'
    const ms = s.durationMs ? ` ${s.durationMs}ms` : ''
    return `  ${s.tool}(${s.input.slice(0, 120)}) → ${status}${ms}`
  }).join('\n')
}

export function buildReflectionPrompt(opts: {
  iteration: number
  outcomes: TaskOutcome[]
  stats: IterationStats
  currentSkills: string[]
  previousAccuracy?: number
}): string {
  const { iteration, outcomes, stats, currentSkills, previousAccuracy } = opts

  const accuracy = stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(1) : '0.0'
  const correct = outcomes.filter(o => o.correct)
  const wrong = outcomes.filter(o => !o.correct && !o.error)
  const errors = outcomes.filter(o => o.error)

  const parts: string[] = [
    `## Self-Improvement — Iteration ${iteration + 1} Reflection`,
    '',
    `You just attempted ${stats.total} tasks.`,
    '',
    `### Accuracy: ${stats.correct}/${stats.total} (${accuracy}%)`,
  ]

  if (previousAccuracy !== undefined) {
    const delta = parseFloat(accuracy) - previousAccuracy
    const direction = delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged'
    parts.push(`Previous accuracy: ${previousAccuracy.toFixed(1)}% — ${direction} by ${Math.abs(delta).toFixed(1)}pp`)
  }

  parts.push('')

  for (const { level, total, correct: c } of stats.byLevel) {
    if (total === 0) continue
    const pct = (c / total * 100).toFixed(1)
    parts.push(`- Level ${level}: ${c}/${total} (${pct}%)`)
  }

  // --- Correct answers: show steps so the agent knows what's working ---
  if (correct.length > 0) {
    parts.push('', '### Correct Answers — Working Strategies (preserve these patterns)', '')

    const shown = correct.slice(0, 20)
    for (const o of shown) {
      parts.push(
        `**L${o.level} — ${o.task_id}** ✓`,
        `> Q: ${o.question.slice(0, 200)}${o.question.length > 200 ? '...' : ''}`,
        `Steps:`,
        formatToolTrace(o.toolTrace || []),
        '',
      )
    }

    if (correct.length > shown.length) {
      parts.push(`_(${correct.length - shown.length} more correct answers not shown)_`, '')
    }
  }

  // --- Wrong answers: show steps + expected answer for diagnosis ---
  if (wrong.length > 0) {
    parts.push('### Wrong Answers — Diagnose and Fix', '')

    const shown = wrong.slice(0, 15)
    for (const o of shown) {
      parts.push(
        `**L${o.level} — ${o.task_id}** ✗`,
        `> Q: ${o.question.slice(0, 300)}${o.question.length > 300 ? '...' : ''}`,
        `- Your answer: \`${o.predicted_answer || '(empty)'}\``,
        `- Correct answer: \`${o.gold_answer}\``,
        `Steps:`,
        formatToolTrace(o.toolTrace || []),
        '',
      )
    }

    if (wrong.length > shown.length) {
      parts.push(`_(${wrong.length - shown.length} more wrong answers not shown)_`, '')
    }
  }

  if (errors.length > 0) {
    parts.push('### Errors', '')
    for (const o of errors.slice(0, 5)) {
      parts.push(
        `- **${o.task_id}**: ${o.error!.slice(0, 120)}`,
        `  Steps: ${formatToolTrace(o.toolTrace || []).trim()}`,
      )
    }
    parts.push('')
  }

  parts.push('### Your Current Skills', '')
  if (currentSkills.length === 0) {
    parts.push('_(none yet — this is your first chance to create some)_')
  } else {
    for (const skill of currentSkills) {
      parts.push(`- \`skills/${skill}\``)
    }
  }

  parts.push(
    '',
    '### Instructions',
    '',
    'Analyze both your successes and failures above. Your goal is to **improve accuracy without regressing** on tasks you already solve correctly.',
    '',
    'Use `write_file` to create or update markdown skill files in the `skills/` directory. These are automatically loaded into your system prompt for future tasks.',
    '',
    'Focus on:',
    '1. **Preserve working strategies** — the correct answers above show approaches that work. Do NOT change skills that would break them.',
    '2. **Answer formatting** — exact-match scoring. Be concise, no extra units/articles/formatting unless the question asks for them.',
    '3. **Tool strategies** — patterns for common task types (file parsing, web research, calculations, audio/image analysis).',
    '4. **Multi-step reasoning** — decomposition strategies for harder questions that require chaining multiple tools.',
    '5. **Common pitfalls** — specific mistakes you keep making that a checklist could prevent.',
    '',
    'Read existing skills first with `read_file` before updating. You can also delete skills that are not helping.',
    '',
    'After creating/updating your skills, briefly summarize what you changed and why.',
  )

  return parts.join('\n')
}

export function computeIterationStats(outcomes: TaskOutcome[], iteration: number): IterationStats {
  const total = outcomes.length
  const correct = outcomes.filter(o => o.correct).length
  const levels = [1, 2, 3]
  const byLevel = levels.map(level => {
    const levelOutcomes = outcomes.filter(o => o.level === level)
    return {
      level,
      total: levelOutcomes.length,
      correct: levelOutcomes.filter(o => o.correct).length,
    }
  })

  return { iteration, total, correct, byLevel }
}
