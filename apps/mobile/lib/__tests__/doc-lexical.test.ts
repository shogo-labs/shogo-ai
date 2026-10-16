// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The doc editor stores markdown, so everything it can show must survive
 * markdown -> Lexical -> markdown unchanged (after normalisation), and
 * reference tokens must become chips, never editable text.
 */
import { describe, expect, test } from 'bun:test'
import { $isCodeNode } from '@lexical/code'
import { $isListItemNode } from '@lexical/list'
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode, type LexicalNode } from 'lexical'
import {
  $createDocRefNode,
  $exportDocMarkdown,
  $importDocMarkdown,
  $isDocRefNode,
  $isRawMarkdownNode,
  createHeadlessDocEditor,
  normalizeDocMarkdown,
} from '../doc-lexical'
import { docTokenFor } from '../doc-tokens'

function walk(node: LexicalNode, visit: (n: LexicalNode) => void) {
  visit(node)
  if ($isElementNode(node)) for (const child of node.getChildren()) walk(child, visit)
}

function inspect(markdown: string) {
  const editor = createHeadlessDocEditor()
  editor.update(() => $importDocMarkdown(markdown), { discrete: true })
  const refs: string[] = []
  const raw: string[] = []
  const codeText: string[] = []
  let out = ''
  editor.getEditorState().read(() => {
    walk($getRoot(), (n) => {
      if ($isDocRefNode(n)) refs.push(n.getToken())
      if ($isRawMarkdownNode(n)) raw.push(n.getMarkdown())
      if ($isCodeNode(n)) codeText.push(n.getTextContent())
    })
    out = $exportDocMarkdown()
  })
  return { refs, raw, codeText, out }
}

const SCHEDULE = `# DevOps Schedule

Lets update this doc whenever someone books a slot with Siva (until we have two more people joining us)

## <!date:2026-10-19>

- 11 AM - 1 PM IST - <@u:ayesha> - Emirates EKB Installation Infra Discussion

## <!date:2026-10-13>

- 3 PM - <@u:sahil> - UCO SSL cert update
- 2 - 2:30 PM IST - <@u:ayesha> - AA EKB Sync`

const CORPUS: Record<string, string> = {
  schedule: SCHEDULE,
  headings: '# One\n\n## Two\n\n### Three\n\nBody text.',
  inline: 'Some **bold**, *italic*, ~~struck~~, `code`, and a [link](https://example.com/a?b=c).',
  bullets: '- one\n- two\n    - nested\n        - deeper\n- three',
  numbered: '1. first\n2. second\n3. third',
  tasks: '- [ ] open task\n- [x] done task\n    - [ ] nested task',
  quote: '> quoted line',
  code: "```ts\nconst mention = '<@u:not-a-chip>'\n```",
  rule: 'Above\n\n---\n\nBelow',
  tokens: 'Ask <@u:u1> or <@a:ws> or <@a:p:p1> in <#c:c1> about <#p:p2> by <!date:2026-10-19> or <!date:2026-10-19T05:30Z>.',
  table: '| Day | Who |\n|---|---|\n| Mon | <@u:u1> |',
  html: '<details>\n<summary>More</summary>\nHidden text\n</details>',
  unknownToken: 'An <@x:unknown> token and a <!date:2026-02-30> bad date stay text.',
  emptyish: '\n\n',
}

describe('markdown round trip', () => {
  for (const [name, markdown] of Object.entries(CORPUS)) {
    test(`${name} is stable after one normalisation`, () => {
      const once = normalizeDocMarkdown(markdown)
      expect(normalizeDocMarkdown(once)).toBe(once)
    })
  }

  test('already-canonical docs come back byte for byte', () => {
    for (const name of ['headings', 'inline', 'bullets', 'numbered', 'tasks', 'quote', 'code', 'rule', 'tokens', 'table', 'html']) {
      expect(normalizeDocMarkdown(CORPUS[name])).toBe(CORPUS[name])
    }
  })

  test('the schedule keeps every line, person and date', () => {
    const { refs, out } = inspect(SCHEDULE)
    expect(refs).toEqual(['<!date:2026-10-19>', '<@u:ayesha>', '<!date:2026-10-13>', '<@u:sahil>', '<@u:ayesha>'])
    for (const line of SCHEDULE.split('\n').filter(Boolean)) expect(out).toContain(line)
  })

  test('an empty doc stays empty', () => {
    expect(normalizeDocMarkdown('')).toBe('')
    expect(normalizeDocMarkdown(CORPUS.emptyish)).toBe('')
  })

  test('other list markers and spacing normalise to one canonical form', () => {
    expect(normalizeDocMarkdown('* a\n* b\n\n\n\nnext')).toBe(normalizeDocMarkdown(normalizeDocMarkdown('* a\n* b\n\n\n\nnext')))
  })
})

describe('reference tokens', () => {
  test('every token kind becomes a chip node', () => {
    const { refs } = inspect(CORPUS.tokens)
    expect(refs).toEqual(['<@u:u1>', '<@a:ws>', '<@a:p:p1>', '<#c:c1>', '<#p:p2>', '<!date:2026-10-19>', '<!date:2026-10-19T05:30Z>'])
  })

  test('tokens inside code blocks stay code', () => {
    const { refs, codeText } = inspect(CORPUS.code)
    expect(refs).toEqual([])
    expect(codeText[0]).toContain('<@u:not-a-chip>')
  })

  test('unknown tokens and impossible dates are left as text', () => {
    const { refs, out } = inspect(CORPUS.unknownToken)
    expect(refs).toEqual([])
    expect(out).toBe(CORPUS.unknownToken)
  })

  test('tokens in tables are preserved inside the raw block', () => {
    const { refs, raw } = inspect(CORPUS.table)
    expect(refs).toEqual([])
    expect(raw).toEqual([CORPUS.table])
  })
})

describe('raw markdown blocks', () => {
  test('tables and HTML are kept verbatim between editable blocks', () => {
    const md = `Intro\n\n${CORPUS.table}\n\nMiddle\n\n${CORPUS.html}\n\nOutro`
    const { raw, out } = inspect(md)
    expect(raw).toEqual([CORPUS.table, CORPUS.html])
    expect(out).toBe(md)
  })

  test('a line starting with a token is not mistaken for HTML', () => {
    const { raw, refs } = inspect('<@u:u1> owns this\n\n<!date:2026-10-19> kickoff')
    expect(raw).toEqual([])
    expect(refs).toEqual(['<@u:u1>', '<!date:2026-10-19>'])
  })
})

describe('agent-written markdown', () => {
  const agentReplace = '# Plan\n\n- [ ] <@u:u1> to draft\n- [ ] Review on <!date:2026-10-20>\n\n## Notes\n\nKeep it short.'
  const appended = `${SCHEDULE}\n\n- 5 PM - <@u:sahil> - Axis`
  const patched = SCHEDULE.replace('## <!date:2026-10-13>\n\n', '## <!date:2026-10-13>\n\n- 9 AM - <@u:jai> - Standup\n')

  test.each([
    ['replace', agentReplace],
    ['append', appended],
    ['patch_section', patched],
  ])('%s output survives the editor untouched', (_mode: string, md: string) => {
    const once = normalizeDocMarkdown(md)
    expect(normalizeDocMarkdown(once)).toBe(once)
    for (const line of md.split('\n').filter(Boolean)) expect(once).toContain(line.trim())
  })
})

describe('editing operations', () => {
  test('a chip inserted into a paragraph exports as its token', () => {
    const editor = createHeadlessDocEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      p.append($createTextNode('Ping '), $createDocRefNode({ kind: 'user', id: 'u9' }), $createTextNode(' today'))
      $getRoot().append(p)
    }, { discrete: true })
    let out = ''
    editor.getEditorState().read(() => (out = $exportDocMarkdown()))
    expect(out).toBe('Ping <@u:u9> today')
  })

  test('replacing a date chip changes only that token', () => {
    const editor = createHeadlessDocEditor()
    editor.update(() => $importDocMarkdown('Kickoff <!date:2026-10-19> then review <!date:2026-10-20>'), { discrete: true })
    editor.update(() => {
      const chips: LexicalNode[] = []
      walk($getRoot(), (n) => $isDocRefNode(n) && chips.push(n))
      ;(chips[0] as any).setRef({ kind: 'date', value: '2026-10-21' })
    }, { discrete: true })
    let out = ''
    editor.getEditorState().read(() => (out = $exportDocMarkdown()))
    expect(out).toBe('Kickoff <!date:2026-10-21> then review <!date:2026-10-20>')
  })

  test('removing a chip removes the whole token', () => {
    const editor = createHeadlessDocEditor()
    editor.update(() => $importDocMarkdown('Owner: <@u:u1> done'), { discrete: true })
    editor.update(() => walk($getRoot(), (n) => $isDocRefNode(n) && n.remove()), { discrete: true })
    let out = ''
    editor.getEditorState().read(() => (out = $exportDocMarkdown()))
    expect(out).toBe('Owner:  done')
  })

  test('ticking a task exports as [x]', () => {
    const editor = createHeadlessDocEditor()
    editor.update(() => $importDocMarkdown('- [ ] ship it'), { discrete: true })
    editor.update(() => walk($getRoot(), (n) => $isListItemNode(n) && n.setChecked(true)), { discrete: true })
    let out = ''
    editor.getEditorState().read(() => (out = $exportDocMarkdown()))
    expect(out).toBe('- [x] ship it')
  })

  test('token helpers and nodes agree', () => {
    expect(docTokenFor({ kind: 'project', id: 'p2' })).toBe('<#p:p2>')
  })
})
