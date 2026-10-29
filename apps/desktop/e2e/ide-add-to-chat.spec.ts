// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * IDE tab "Add to Chat" end to end (#1082), on the streaming harness: the dev
 * Electron app, the local API and runtime, and the fake model, so the last
 * hop (what the model actually receives) is asserted too.
 *
 *   cd apps/desktop
 *   npm run test:e2e:ide
 *
 * Reuse a warm Metro for this checkout with SHOGO_E2E_DEV_URL=http://localhost:<port>.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { apiFetch, composer, launchDesktop, log, snapshotFailure, waitIdle, type Harness } from './streaming/desktop-app'

test.skip(process.env.PLAYWRIGHT_E2E !== '1', 'set PLAYWRIGHT_E2E=1 to run')
test.describe.configure({ mode: 'serial' })

const BIG_LINES = 300
const bigLine = (i: number) => `export const line${String(i).padStart(3, '0')} = ${i} // big.ts line ${i}`
const BIG_TS = Array.from({ length: BIG_LINES }, (_, i) => bigLine(i + 1)).join('\n') + '\n'
const SEED: Record<string, string> = {
  'src/big.ts': BIG_TS,
  'src/small.ts': 'export const small = 1\n',
  'src/util/helpers.ts': 'export const helper = () => 42\n',
}

let h: Harness
let page: Page

test.beforeAll(async () => {
  h = await launchDesktop()
  page = h.page
  for (const [path, content] of Object.entries(SEED)) {
    const res = await apiFetch(page, `/api/projects/${encodeURIComponent(h.projectId)}/files/${path}`, {
      method: 'PUT',
      body: { content },
    })
    expect(res.status, `seed ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(400)
  }
  await page.getByTestId('project-tab-ide').first().click()
  await expect(explorer()).toBeVisible({ timeout: 60_000 })
  await revealInTree('src')
  await expect(treeRow('big.ts')).toBeVisible({ timeout: 30_000 })
  log('IDE tab open with the seeded files')
})

test.afterAll(async () => {
  await h?.close()
})

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await snapshotFailure(page, `ide-add-to-chat-${info.title.replace(/\W+/g, '-')}`)
})

function explorer(): Locator {
  return page.getByLabel('Explorer', { exact: true }).first()
}

function treeRow(name: string): Locator {
  return explorer().getByText(name, { exact: true }).first()
}

/** Expands a top-level folder in the tree (and refreshes it once if the seed hasn't shown up yet). */
async function revealInTree(folder: string): Promise<void> {
  const row = treeRow(folder)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.click()
}

async function clearComposer(): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill('')
  await expect(input).toHaveValue('')
}

/**
 * HTML5 drag from `source` onto `target` through one shared DataTransfer, the
 * way Chromium delivers a real drag: dragstart on the source, dragenter /
 * dragover / drop on the target, dragend on the source.
 */
async function dragOnto(source: Locator, target: Locator): Promise<void> {
  const src = await source.elementHandle()
  const dst = await target.elementHandle()
  if (!src || !dst) throw new Error('drag source or target is missing')
  await page.evaluate(
    ([s, t]) => {
      const dt = new DataTransfer()
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }))
      fire(s, 'dragstart')
      fire(t, 'dragenter')
      fire(t, 'dragover')
      fire(t, 'drop')
      fire(s, 'dragend')
    },
    [src, dst] as const,
  )
}

/** Drops an OS file (a `File` in the DataTransfer, no Shogo payload) onto `target`. */
async function dropOsFile(target: Locator, name: string, content: string): Promise<void> {
  const dst = await target.elementHandle()
  if (!dst) throw new Error('drop target is missing')
  await page.evaluate(
    ([t, n, c]) => {
      const dt = new DataTransfer()
      dt.items.add(new File([c], n, { type: 'text/plain' }))
      for (const type of ['dragenter', 'dragover', 'drop']) {
        t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }))
      }
    },
    [dst, name, content] as const,
  )
}

/** Opens big.ts and selects whole lines `from`..`to` in its Monaco editor. */
async function selectLines(from: number, to: number): Promise<void> {
  await page.waitForFunction(
    () => ((window as any).monaco?.editor?.getEditors?.() ?? []).some((e: any) => e.getModel()?.uri.path.endsWith('/big.ts')),
    undefined,
    { timeout: 60_000 },
  )
  await page.evaluate(
    ([a, b]) => {
      const monaco = (window as any).monaco
      const ed = monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
      const model = ed.getModel()
      ed.setSelection(new monaco.Selection(a, 1, b, model.getLineMaxColumn(b)))
      ed.revealLineInCenter(a)
      ed.focus()
    },
    [from, to] as const,
  )
}

/** Finds a Monaco context-menu item by label; Monaco renders its menu inside a shadow root. */
async function monacoMenuItem(label: string): Promise<import('@playwright/test').ElementHandle<Element> | null> {
  const handle = await page.evaluateHandle((l) => {
    const roots: Array<Document | ShadowRoot> = [document]
    while (roots.length > 0) {
      const root = roots.shift()!
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) roots.push(el.shadowRoot)
        if (el.classList.contains('action-menu-item') && (el.textContent ?? '').trim().startsWith(l)) return el
      }
    }
    return null
  }, label)
  return handle.asElement()
}

async function waitForMonacoMenuItem(label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const item = await monacoMenuItem(label)
    if (item || Date.now() > deadline) return item
    await page.waitForTimeout(150)
  }
}

/** Opens big.ts's editor context menu over the selection and clicks `label`. */
async function editorContextMenu(line: number, label: string): Promise<void> {
  const at = await pointInLine(line)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  let item = await waitForMonacoMenuItem(label, 3_000)
  if (!item) {
    // Synthetic right-clicks don't always reach Monaco's mouse handler; open the same menu the keyboard way.
    await page.evaluate(() => {
      const ed = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
      ed.focus()
      ed.trigger('e2e', 'editor.action.showContextMenu', null)
    })
    item = await waitForMonacoMenuItem(label, 10_000)
  }
  if (!item) throw new Error(`the editor context menu has no "${label}" item`)
  // Monaco only arms an item's mouseup handler 100 ms after the menu renders.
  await page.waitForTimeout(400)
  await item.click()
}

/** Viewport point inside line `line` of big.ts's editor, for a right-click that keeps the selection. */
async function pointInLine(line: number): Promise<{ x: number; y: number }> {
  return page.evaluate((l) => {
    const monaco = (window as any).monaco
    const ed = monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
    const pos = ed.getScrolledVisiblePosition({ lineNumber: l, column: 5 })
    const rect = ed.getDomNode().getBoundingClientRect()
    return { x: rect.left + pos.left + 4, y: rect.top + pos.top + pos.height / 2 }
  }, line)
}

test('1. dragging a file from the tree adds an @ reference and keeps the draft', async () => {
  await clearComposer()
  await composer(page).fill('Look at this: ')
  await dragOnto(treeRow('big.ts'), composer(page))
  await expect(composer(page)).toHaveValue(/^Look at this: @big\.ts\s*$/)
})

test('2. dragging a multi-selection of two files and a folder adds three references', async () => {
  await clearComposer()
  await treeRow('small.ts').click()
  await treeRow('big.ts').click({ modifiers: ['ControlOrMeta'] })
  await treeRow('util').click({ modifiers: ['ControlOrMeta'] })
  await dragOnto(treeRow('util'), composer(page))
  const value = await composer(page).inputValue()
  expect(value).toContain('@small.ts')
  expect(value).toContain('@big.ts')
  expect(value).toContain('@util')
  expect(value.match(/@/g)?.length).toBe(3)
})

test('3. Ctrl/Cmd+L and editor right-click "Add to Chat" add line-range references', async () => {
  await clearComposer()
  await treeRow('big.ts').click()
  await selectLines(120, 140)
  await page.keyboard.press('ControlOrMeta+L')
  await expect(composer(page)).toHaveValue(/@big\.ts:120-140/)

  await selectLines(10, 12)
  await editorContextMenu(11, 'Add to Chat')
  await expect(composer(page)).toHaveValue(/@big\.ts:120-140.*@big\.ts:10-12/)
})

test('4. sending carries the selections to the runtime and into the model prompt', async () => {
  const chatBodies: any[] = []
  const onRequest = (req: import('@playwright/test').Request) => {
    if (req.method() !== 'POST' || !/\/chat$/.test(new URL(req.url()).pathname)) return
    try {
      chatBodies.push(req.postDataJSON())
    } catch {
      /* not JSON */
    }
  }
  page.on('request', onRequest)
  try {
    const turnsBefore = h.llm.turns.length
    await composer(page).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect.poll(() => chatBodies.length, { timeout: 30_000 }).toBeGreaterThan(0)

    const refs = chatBodies.flatMap((b) => (Array.isArray(b?.references) ? b.references : []))
    const selection = refs.find((r: any) => r?.type === 'selection' && r.startLine === 120)
    expect(selection, JSON.stringify(refs).slice(0, 500)).toMatchObject({ type: 'selection', path: 'src/big.ts', startLine: 120, endLine: 140 })
    expect(selection.text).toContain(bigLine(120))
    expect(selection.text).toContain(bigLine(140))
    expect(selection.text).not.toContain(bigLine(141))
    expect(refs.some((r: any) => r?.type === 'selection' && r.startLine === 10 && r.endLine === 12)).toBe(true)

    await expect
      .poll(() => h.llm.turns.slice(turnsBefore).find((t) => t.userText.includes('[Referenced Selection: src/big.ts lines 120-140'))?.userText ?? '', {
        timeout: 60_000,
      })
      .toContain(bigLine(130))
    const prompt = h.llm.turns.slice(turnsBefore).find((t) => t.userText.includes('[Referenced Selection: src/big.ts lines 120-140'))!.userText
    expect(prompt).toContain('[Referenced Selection: src/big.ts lines 10-12')
    expect(prompt).not.toContain(bigLine(200))
    await waitIdle(page, 60_000)
  } finally {
    page.off('request', onRequest)
  }
})

test('5. tree right-click "Add to Chat" with the chat collapsed expands it with the reference', async () => {
  await clearComposer()
  // The collapsed panel keeps its (zero-width) composer mounted, so the toggle's label is the state to check.
  await page.getByLabel('Collapse chat', { exact: true }).first().click()
  await expect(page.getByLabel('Expand chat', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await treeRow('small.ts').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to Chat' }).first().click()
  await expect(page.getByLabel('Collapse chat', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(composer(page)).toBeVisible()
  await expect(composer(page)).toHaveValue(/@small\.ts/)
})

test('Ctrl/Cmd+L without a selection adds the whole file; multi-cursor adds every range', async () => {
  await clearComposer()
  await treeRow('big.ts').click()
  await selectLines(1, 1)
  await page.evaluate(() => {
    const ed = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
    ed.setPosition({ lineNumber: 5, column: 1 })
    ed.focus()
  })
  await page.keyboard.press('ControlOrMeta+L')
  await expect(composer(page)).toHaveValue(/^@big\.ts\s*$/)

  await clearComposer()
  await page.evaluate(() => {
    const monaco = (window as any).monaco
    const ed = monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
    const m = ed.getModel()
    ed.setSelections([
      new monaco.Selection(30, 1, 31, m.getLineMaxColumn(31)),
      new monaco.Selection(50, 1, 50, m.getLineMaxColumn(50)),
    ])
    ed.focus()
  })
  await page.keyboard.press('ControlOrMeta+L')
  await expect(composer(page)).toHaveValue(/@big\.ts:30-31 @big\.ts:50\b/)
})

test('adding a file with unsaved edits warns that the agent reads the saved file', async () => {
  await clearComposer()
  await page.evaluate(() => {
    const monaco = (window as any).monaco
    const ed = monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
    ed.executeEdits('e2e', [{ range: new monaco.Range(1, 1, 1, 1), text: '// unsaved\n' }])
  })
  await treeRow('big.ts').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to Chat' }).first().click()
  await expect(composer(page)).toHaveValue(/@big\.ts/)
  await expect(page.getByText('big.ts has unsaved changes', { exact: false }).first()).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => {
    const ed = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.path.endsWith('/big.ts'))
    ed.trigger('e2e', 'undo', null)
  })
})

test('6. terminal Ctrl/Cmd+L appends to the draft and keeps the pending attachment', async () => {
  await clearComposer()
  await dropOsFile(composer(page), 'terminal-pending.txt', 'pending attachment')
  await expect(page.getByText('terminal-pending.txt').first()).toBeVisible({ timeout: 15_000 })
  await composer(page).fill('Draft before terminal')
  // ⌘⇧` / Ctrl+Shift+`: new terminal and open the bottom panel, then make sure its Terminal tab is showing.
  await page.keyboard.press('ControlOrMeta+Shift+Backquote')
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click()
  // Every terminal tab keeps its xterm mounted; only the active one is visible.
  const term = page.locator('.xterm').filter({ visible: true }).first()
  await expect(term).toBeVisible({ timeout: 60_000 })
  await term.click()
  await page.keyboard.type('echo shogo-term-marker')
  await page.keyboard.press('Enter')
  // The terminal renders to a canvas, so there is no output DOM to wait on:
  // re-send Ctrl/Cmd+L until the echoed marker has reached the draft.
  await expect(async () => {
    await term.click()
    await page.keyboard.press('ControlOrMeta+L')
    await expect(composer(page)).toHaveValue(/^Draft before terminal[\s\S]*shogo-term-marker/, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.getByText('terminal-pending.txt').first()).toBeVisible()
})

test('7. dropping an OS file still attaches it', async () => {
  await clearComposer()
  await dropOsFile(composer(page), 'dropped-notes.txt', 'notes from the OS')
  await expect(page.getByText('dropped-notes.txt').first()).toBeVisible({ timeout: 15_000 })
  await expect(composer(page)).toHaveValue('')
})
