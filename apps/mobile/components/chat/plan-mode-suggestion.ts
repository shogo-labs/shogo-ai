// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export const PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS = 10

const MIN_PROMPT_LENGTH = 24

const QUESTION_PREFIXES = [
  "can you ",
  "could you ",
  "what ",
  "why ",
  "who ",
  "where ",
  "when ",
  "which ",
  "can you explain",
  "explain ",
  "tell me ",
  "how do i ",
  "how does ",
]

const TINY_COMMAND_PREFIXES = [
  "run ",
  "show ",
  "list ",
  "open ",
  "read ",
  "cat ",
  "ls",
  "pwd",
]

const PLANNING_INTENT_PATTERNS = [
  /\bplan(?:ning)?\b/i,
  /\bstep[-\s]?by[-\s]?step\b/i,
  /\bbefore (?:coding|implementing|changing|building)\b/i,
  /\broll(?:\s|-)?out\b/i,
]

const WORK_INTENT_PATTERNS = [
  /\badd support\b/i,
  /\baudit\b/i,
  /\bbuild(?:ing)?\b/i,
  /\bchange\b/i,
  /\bcreate\b/i,
  /\bdebug\b/i,
  /\bdesign\b/i,
  /\benhance\b/i,
  /\bfix\b/i,
  /\bimplement(?:ation)?\b/i,
  /\binvestigate\b/i,
  /\bmigrat(?:e|ion|ing)\b/i,
  /\brefactor(?:ing)?\b/i,
  /\brework\b/i,
  /\btest\b/i,
  /\bupdate\b/i,
  /\bverify\b/i,
]

const NEGATED_PLAN_PATTERNS = [
  /\b(?:no|without) (?:a )?plan\b/i,
  /\bdon'?t (?:need|want|make|create) (?:a )?plan\b/i,
  /\bdon'?t (?:switch|use|enter|move) (?:to|into)? ?plan mode\b/i,
  /\bdo not (?:need|want|make|create) (?:a )?plan\b/i,
  /\bdo not (?:switch|use|enter|move) (?:to|into)? ?plan mode\b/i,
]

const EXPLICIT_PLANNING_PATTERNS = [
  /\bplan(?:ning)?\b/i,
  /\bstep[-\s]?by[-\s]?step\b/i,
  /\broll(?:\s|-)?out\b/i,
]

const RISKY_SCOPE_PATTERNS = [
  /\bdatabase\b/i,
  /\bauth(?:entication|orization)?\b/i,
  /\bschema\b/i,
  /\bdeployment\b/i,
  /\bci\b/i,
  /\bworkflow\b/i,
  /\bkubernetes\b/i,
  /\bk8s\b/i,
  /\bprisma\b/i,
  /\bredis\b/i,
  /\bapi\b/i,
  /\bbackend\b/i,
  /\bfrontend\b/i,
  /\bmobile\b/i,
]

const MULTI_FILE_PATTERNS = [
  /\bacross\b/i,
  /\bmulti[-\s]?file\b/i,
  /\bseveral files\b/i,
  /\bmultiple files\b/i,
  /\bend[-\s]?to[-\s]?end\b/i,
  /\bfull flow\b/i,
]

const COMPLEXITY_PATTERNS = [
  /\barchitecture\b/i,
  /\bcoverage\b/i,
  /\bcross[-\s]?verify\b/i,
  /\bfrom scratch\b/i,
  /\bintegration\b/i,
  /\blarge\b/i,
  /\bmulti[-\s]?step\b/i,
  /\bproduction\b/i,
  /\bregression\b/i,
  /\bsystem\b/i,
]

function normalizePrompt(prompt: string) {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase()
}

function startsWithAny(value: string, prefixes: string[]) {
  return prefixes.some((prefix) => value.startsWith(prefix))
}

export function shouldSuggestPlanMode(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (normalized.length < MIN_PROMPT_LENGTH) return false

  const hasExplicitPlanningIntent = PLANNING_INTENT_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  )
  const hasWorkIntent = WORK_INTENT_PATTERNS.some((pattern) => pattern.test(normalized))
  const hasRiskyScope = RISKY_SCOPE_PATTERNS.some((pattern) => pattern.test(normalized))
  const hasMultiFileScope = MULTI_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
  const hasComplexitySignal = COMPLEXITY_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  )

  if (NEGATED_PLAN_PATTERNS.some((pattern) => pattern.test(normalized))) return false
  if (
    startsWithAny(normalized, TINY_COMMAND_PREFIXES) &&
    normalized.length < 80 &&
    !hasMultiFileScope &&
    !EXPLICIT_PLANNING_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return false
  }

  if (hasExplicitPlanningIntent) return true

  const looksLikeInformationQuestion = startsWithAny(normalized, QUESTION_PREFIXES)
  if (
    looksLikeInformationQuestion &&
    !(hasWorkIntent && hasMultiFileScope && (hasRiskyScope || hasComplexitySignal))
  ) {
    return false
  }

  if (!hasWorkIntent && !hasMultiFileScope) return false

  return (
    (hasMultiFileScope &&
      hasWorkIntent &&
      (hasRiskyScope || hasComplexitySignal || normalized.length >= 90)) ||
    (hasRiskyScope &&
      hasWorkIntent &&
      (hasComplexitySignal || normalized.length >= 90)) ||
    (hasWorkIntent && hasComplexitySignal && normalized.length >= 60) ||
    (hasWorkIntent && normalized.length >= 140)
  )
}
