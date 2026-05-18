// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect } from 'bun:test'
import type { Message } from '@mariozechner/pi-ai'
import {
  buildForkDirective,
  isInForkChild,
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
  SUBAGENT_GUIDE,
  TEAMMATE_PROMPT_ADDENDUM,
} from '../subagent-prompts'

describe('buildForkDirective', () => {
  it('wraps the directive in <fork-boilerplate> and appends the directive', () => {
    const out = buildForkDirective('refactor foo.ts')
    expect(out).toContain(`<${FORK_BOILERPLATE_TAG}>`)
    expect(out).toContain(`</${FORK_BOILERPLATE_TAG}>`)
    expect(out).toContain(`${FORK_DIRECTIVE_PREFIX}refactor foo.ts`)
    expect(out.trim().endsWith('refactor foo.ts')).toBe(true)
  })

  it('includes the non-negotiable RULES section', () => {
    const out = buildForkDirective('x')
    expect(out).toContain('RULES (non-negotiable):')
    expect(out).toMatch(/Scope:/)
  })
})

describe('isInForkChild', () => {
  const tag = `<${FORK_BOILERPLATE_TAG}>`

  it('returns false for an empty message list', () => {
    expect(isInForkChild([])).toBe(false)
  })

  it('returns false when no user message contains the tag', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'plain prompt' },
      { role: 'assistant', content: 'plain reply' },
    ] as any
    expect(isInForkChild(msgs)).toBe(false)
  })

  it('detects the tag in a plain-string user message', () => {
    const msgs: Message[] = [
      { role: 'user', content: `prefix ${tag} suffix` },
    ] as any
    expect(isInForkChild(msgs)).toBe(true)
  })

  it('detects the tag inside an assistant-style content-block array', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: `wrapped ${tag} here` },
        ],
      },
    ] as any
    expect(isInForkChild(msgs)).toBe(true)
  })

  it('ignores the tag if it only appears in an assistant message', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: `${tag} mentioned in reply` },
    ] as any
    expect(isInForkChild(msgs)).toBe(false)
  })

  it('handles content blocks without a text property gracefully', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: 'http://x' } as any,
          { type: 'text', text: 'no tag here' },
        ],
      },
    ] as any
    expect(isInForkChild(msgs)).toBe(false)
  })
})

describe('exported prompt strings', () => {
  it('SUBAGENT_GUIDE references the default agent types', () => {
    expect(SUBAGENT_GUIDE).toContain('explore')
    expect(SUBAGENT_GUIDE).toContain('general-purpose')
    expect(SUBAGENT_GUIDE).toContain('code-reviewer')
    expect(SUBAGENT_GUIDE).toContain('browser_qa')
  })

  it('TEAMMATE_PROMPT_ADDENDUM mentions send_team_message', () => {
    expect(TEAMMATE_PROMPT_ADDENDUM).toContain('send_team_message')
  })
})
