'use dom'
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The channel doc editor: Lexical, always editable in place (unless the doc
 * is locked or you can't edit), with chips for people, agents, channels,
 * projects and dates, a toolbar, and the shared "@" menu.
 *
 * An Expo DOM component: on web it renders inline, on native inside a
 * webview. Everything here is plain DOM and CSS, and everything crossing the
 * boundary (props, callbacks, the imperative handle) is JSON.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useDOMImperativeHandle, type DOMProps } from 'expo/dom'
import { $createCodeNode } from '@lexical/code'
import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { TabIndentationPlugin } from '@lexical/react/LexicalTabIndentationPlugin'
import { LexicalTypeaheadMenuPlugin, MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import { $getNearestNodeOfType, mergeRegister } from '@lexical/utils'
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  FORMAT_TEXT_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
  type TextFormatType,
  type TextNode,
} from 'lexical'
import { docTokenFor, parseDocToken, type DocRef } from '../../../lib/doc-tokens'
import {
  $createDocRefNode,
  $exportDocMarkdown,
  $importDocMarkdown,
  $isDocRefNode,
  DOC_NODES,
  DOC_TRANSFORMERS,
  setDocRefRenderer,
  setRawMarkdownRenderer,
} from '../../../lib/doc-lexical'
import {
  DOC_CATEGORIES,
  buildMentionMenu,
  docRefLabel,
  recentMentions,
  rememberMention,
  type MentionCategory,
  type MentionMenuData,
  type MentionRow,
} from '../../../lib/mention-menu'
import type { DocChipPress, DocEditorData, DocEditorHandle } from './types'

interface DocEditorProps {
  ref?: Ref<DocEditorHandle>
  /** Initial content; later changes go through `setMarkdown`. */
  markdown: string
  editable: boolean
  workspaceId: string
  data: DocEditorData
  dark?: boolean
  placeholder?: string
  onChange?: (markdown: string) => void
  onChipPress?: (press: DocChipPress) => void
  onRequestDatePicker?: () => void
  dom?: DOMProps
}

interface DocContextValue {
  data: MentionMenuData
  editable: boolean
  onChipPress?: (press: DocChipPress) => void
}

const DocContext = createContext<DocContextValue | null>(null)

const THEME = {
  paragraph: 'sd-p',
  quote: 'sd-quote',
  heading: { h1: 'sd-h1', h2: 'sd-h2', h3: 'sd-h3', h4: 'sd-h4', h5: 'sd-h4', h6: 'sd-h4' },
  list: {
    ul: 'sd-ul',
    ol: 'sd-ol',
    listitem: 'sd-li',
    listitemChecked: 'sd-li-checked',
    listitemUnchecked: 'sd-li-unchecked',
    nested: { listitem: 'sd-li-nested' },
  },
  text: { bold: 'sd-b', italic: 'sd-i', strikethrough: 'sd-s', underline: 'sd-u', code: 'sd-code' },
  code: 'sd-codeblock',
  link: 'sd-link',
  hr: 'sd-hr',
}

setDocRefRenderer((ref, nodeKey) => <DocChip docRef={ref} nodeKey={nodeKey} />)
setRawMarkdownRenderer((markdown) => <RawBlock markdown={markdown} />)

export default function DocEditor(props: DocEditorProps) {
  const { markdown, editable, workspaceId, dark = false } = props
  const data = useMemo<MentionMenuData>(
    () => ({ ...props.data, memberIds: props.data.memberIds ? new Set(props.data.memberIds) : null, now: new Date() }),
    [props.data],
  )
  const initialConfig = useMemo(
    () => ({
      namespace: 'channel-doc',
      nodes: DOC_NODES,
      theme: THEME,
      editable,
      editorState: () => $importDocMarkdown(markdown),
      onError: (err: Error) => console.error('[doc-editor]', err),
    }),
    // The initial state only; later content arrives through `setMarkdown`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const ctx = useMemo<DocContextValue>(() => ({ data, editable, onChipPress: props.onChipPress }), [data, editable, props.onChipPress])
  const inWebView = typeof window !== 'undefined' && !!(window as any).ReactNativeWebView

  return (
    <DocContext.Provider value={ctx}>
      <style>{CSS}</style>
      {inWebView ? <style>{WEBVIEW_CSS}</style> : null}
      <div className={`sd-theme sd-doc${dark ? ' sd-dark' : ''}`} data-testid="doc-editor">
        <LexicalComposer initialConfig={initialConfig}>
          {editable ? <Toolbar onRequestDatePicker={props.onRequestDatePicker} /> : null}
          <div className="sd-scroll">
            <RichTextPlugin
              contentEditable={<ContentEditable className="sd-content" aria-label="Channel doc" data-testid="doc-editor-content" />}
              placeholder={
                <div className="sd-placeholder">
                  {editable ? props.placeholder ?? 'Write something. Type @ to add people, agents, channels, projects or dates.' : 'This doc is empty.'}
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
          </div>
          <HistoryPlugin />
          <ListPlugin />
          <CheckListPlugin />
          <LinkPlugin />
          <ClickableLinkPlugin disabled={editable} />
          <HorizontalRulePlugin />
          <TabIndentationPlugin />
          <MarkdownShortcutPlugin transformers={DOC_TRANSFORMERS} />
          {editable ? (
            <MentionTypeahead data={data} workspaceId={workspaceId} dark={dark} onRequestDatePicker={props.onRequestDatePicker} />
          ) : null}
          <BridgePlugin handleRef={props.ref} editable={editable} onChange={props.onChange} />
        </LexicalComposer>
      </div>
    </DocContext.Provider>
  )
}

// ─── Bridge: content in and out ──────────────────────────────────────────────

const REMOTE_TAG = 'doc-remote'

function exportMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $exportDocMarkdown())
}

function BridgePlugin({ handleRef, editable, onChange }: { handleRef?: Ref<DocEditorHandle>; editable: boolean; onChange?: (md: string) => void }) {
  const [editor] = useLexicalComposerContext()
  const last = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    last.current = exportMarkdown(editor)
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      const md = exportMarkdown(editor)
      if (md === last.current) return
      last.current = md
      onChangeRef.current?.(md)
    }
    const unregister = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
      if (tags.has(REMOTE_TAG) || (!dirtyElements.size && !dirtyLeaves.size)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 250)
    })
    const root = editor.getRootElement()
    const onBlur = () => {
      if (timer) clearTimeout(timer)
      flush()
    }
    root?.addEventListener('blur', onBlur)
    return () => {
      unregister()
      root?.removeEventListener('blur', onBlur)
      if (timer) {
        clearTimeout(timer)
        flush()
      }
    }
  }, [editor])

  useDOMImperativeHandle<DocEditorHandle>(
    handleRef as Ref<DocEditorHandle>,
    () => ({
      setMarkdown(markdown: string) {
        editor.update(() => $importDocMarkdown(markdown), { tag: REMOTE_TAG, discrete: true })
        last.current = exportMarkdown(editor)
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
      },
      insertToken(token: string) {
        const ref = parseDocToken(token)
        if (!ref) return
        editor.update(() => {
          if (!$getSelection()) $getRoot().selectEnd()
          $insertChip(ref, null)
        })
        editor.focus()
      },
      replaceToken(nodeKey: string, token: string | null) {
        editor.update(() => {
          const node = $getNodeByKey(nodeKey)
          if (!$isDocRefNode(node)) return
          const ref = token ? parseDocToken(token) : null
          if (ref) node.setRef(ref)
          else node.remove()
        })
      },
      focus() {
        editor.focus()
      },
    }),
    [editor],
  )
  return null
}

/** Put a chip (and a space after it) where `replacing` is, or at the selection. */
function $insertChip(ref: DocRef, replacing: TextNode | null) {
  const chip = $createDocRefNode(ref)
  if (replacing) replacing.replace(chip)
  else $insertNodes([chip])
  const space = $createTextNode(' ')
  chip.insertAfter(space)
  space.select(1, 1)
}

// ─── Chips and raw blocks ────────────────────────────────────────────────────

function DocChip({ docRef, nodeKey }: { docRef: DocRef; nodeKey: string }) {
  const ctx = useContext(DocContext)
  const [isSelected] = useLexicalNodeSelection(nodeKey)
  if (!ctx) return null
  const label = docRefLabel(docRef, ctx.data)
  const token = docTokenFor(docRef)
  const isMe = docRef.kind === 'user' && docRef.id === ctx.data.meId
  const className = [
    'sd-chip',
    `sd-chip-${docRef.kind}`,
    label.known ? '' : 'sd-chip-unknown',
    isMe ? 'sd-chip-me' : '',
    isSelected ? 'sd-chip-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span
      className={className}
      data-doc-token={token}
      data-testid="doc-chip"
      role="button"
      title={label.text}
      onClick={(e) => {
        e.preventDefault()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        ctx.onChipPress?.({ token, nodeKey, x: r.left, y: r.bottom, editable: ctx.editable })
      }}
    >
      {docRef.kind === 'date' ? <span className="sd-chip-icon" aria-hidden>▦</span> : null}
      {label.text}
    </span>
  )
}

function parseTable(markdown: string): string[][] | null {
  const lines = markdown.trim().split('\n')
  if (lines.length < 2 || !lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) return null
  if (!/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(lines[1])) return null
  const cells = (l: string) => l.trim().slice(1, -1).split('|').map((c) => c.trim())
  return [cells(lines[0]), ...lines.slice(2).map(cells)]
}

function RawBlock({ markdown }: { markdown: string }) {
  const table = parseTable(markdown)
  if (!table) return <pre className="sd-raw" data-testid="doc-raw-block">{markdown}</pre>
  const [head, ...body] = table
  return (
    <table className="sd-table" data-testid="doc-raw-block">
      <thead>
        <tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>{row.map((c, i) => <td key={i}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

type BlockType = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote' | 'code' | 'other'

interface ToolbarState {
  formats: Record<string, boolean>
  block: BlockType
}

const FORMATS: Array<{ format: TextFormatType; label: string; title: string; className: string }> = [
  { format: 'bold', label: 'B', title: 'Bold', className: 'sd-b' },
  { format: 'italic', label: 'I', title: 'Italic', className: 'sd-i' },
  { format: 'strikethrough', label: 'S', title: 'Strikethrough', className: 'sd-s' },
  { format: 'code', label: '</>', title: 'Inline code', className: '' },
]

function currentBlock(): BlockType {
  const sel = $getSelection()
  if (!$isRangeSelection(sel)) return 'other'
  const anchor = sel.anchor.getNode()
  const list = $getNearestNodeOfType(anchor, ListNode)
  if ($isListNode(list)) return list.getListType()
  const top = anchor.getKey() === 'root' ? null : anchor.getTopLevelElement()
  if (!top) return 'paragraph'
  if ($isHeadingNode(top)) return (['h1', 'h2', 'h3'].includes(top.getTag()) ? top.getTag() : 'h3') as BlockType
  if ($isQuoteNode(top)) return 'quote'
  if (top.getType() === 'code') return 'code'
  return 'paragraph'
}

function Toolbar({ onRequestDatePicker }: { onRequestDatePicker?: () => void }) {
  const [editor] = useLexicalComposerContext()
  const [state, setState] = useState<ToolbarState>({ formats: {}, block: 'paragraph' })

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) =>
        editorState.read(() => {
          const sel = $getSelection()
          const formats: Record<string, boolean> = {}
          if ($isRangeSelection(sel)) for (const f of FORMATS) formats[f.format] = sel.hasFormat(f.format)
          setState({ formats, block: currentBlock() })
        }),
      ),
    [editor],
  )

  const setBlock = useCallback(
    (block: BlockType) => {
      if (block === 'bullet' || block === 'number' || block === 'check') {
        if (state.block === block) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)
        else
          editor.dispatchCommand(
            block === 'bullet' ? INSERT_UNORDERED_LIST_COMMAND : block === 'number' ? INSERT_ORDERED_LIST_COMMAND : INSERT_CHECK_LIST_COMMAND,
            undefined,
          )
        return
      }
      editor.update(() => {
        const sel = $getSelection()
        if (!$isRangeSelection(sel)) return
        const target = state.block === block ? 'paragraph' : block
        $setBlocksType(sel, () => {
          if (target === 'h1' || target === 'h2' || target === 'h3') return $createHeadingNode(target)
          if (target === 'quote') return $createQuoteNode()
          if (target === 'code') return $createCodeNode()
          return $createParagraphNode()
        })
      })
    },
    [editor, state.block],
  )

  const insertAt = useCallback(() => {
    editor.update(() => {
      const sel = $getSelection()
      if (!$isRangeSelection(sel)) {
        $getRoot().selectEnd()
      }
      const range = $getSelection()
      if (!$isRangeSelection(range)) return
      const before = range.anchor.getNode().getTextContent().slice(0, range.anchor.offset)
      range.insertText(before && !/\s$/.test(before) ? ' @' : '@')
    })
    editor.focus()
  }, [editor])

  const link = useCallback(() => {
    const url = window.prompt('Link address')
    if (url === null) return
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim() ? url.trim() : null)
  }, [editor])

  const button = (key: string, label: string, title: string, active: boolean, onPress: () => void, className = '') => (
    <button
      key={key}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`sd-tool${active ? ' sd-tool-active' : ''} ${className}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {label}
    </button>
  )

  return (
    <div className="sd-toolbar" role="toolbar" aria-label="Formatting">
      {FORMATS.map((f) => button(f.format, f.label, f.title, !!state.formats[f.format], () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f.format), f.className))}
      <span className="sd-sep" />
      {button('h1', 'H1', 'Heading 1', state.block === 'h1', () => setBlock('h1'))}
      {button('h2', 'H2', 'Heading 2', state.block === 'h2', () => setBlock('h2'))}
      {button('h3', 'H3', 'Heading 3', state.block === 'h3', () => setBlock('h3'))}
      <span className="sd-sep" />
      {button('bullet', '•', 'Bulleted list', state.block === 'bullet', () => setBlock('bullet'))}
      {button('number', '1.', 'Numbered list', state.block === 'number', () => setBlock('number'))}
      {button('check', '☐', 'Checklist', state.block === 'check', () => setBlock('check'))}
      {button('quote', '❝', 'Quote', state.block === 'quote', () => setBlock('quote'))}
      {button('code', '{ }', 'Code block', state.block === 'code', () => setBlock('code'))}
      {button('link', '🔗', 'Link', false, link)}
      <span className="sd-sep" />
      {button('mention', '@', 'Mention', false, insertAt)}
      {onRequestDatePicker ? button('date', '▦', 'Insert date', false, onRequestDatePicker) : null}
    </div>
  )
}

// ─── The "@" menu ────────────────────────────────────────────────────────────

class RowOption extends MenuOption {
  row: MentionRow
  constructor(row: MentionRow) {
    super(row.key)
    this.row = row
  }
}

// "@" then up to two words, so "@oct 19" and "@Sam Lee" both search.
const TRIGGER = /(^|[\s(])@([^\s@<>]{0,30}(?: [^\s@<>]{0,20})?)$/

function triggerFn(text: string) {
  const m = TRIGGER.exec(text)
  if (!m) return null
  return { leadOffset: m.index + m[1].length, matchingString: m[2], replaceableString: `@${m[2]}` }
}

function MentionTypeahead({
  data,
  workspaceId,
  dark,
  onRequestDatePicker,
}: {
  data: MentionMenuData
  workspaceId: string
  dark: boolean
  onRequestDatePicker?: () => void
}) {
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState<string | null>(null)
  const [drill, setDrill] = useState<MentionCategory | null>(null)

  const menu = useMemo(
    () => (query === null ? null : buildMentionMenu({ ...data, recent: recentMentions(workspaceId), now: new Date() }, DOC_CATEGORIES, query, drill)),
    [data, workspaceId, query, drill],
  )
  const options = useMemo(() => (menu?.rows ?? []).map((r) => new RowOption(r)), [menu])

  const onQueryChange = useCallback((q: string | null) => {
    setQuery(q)
    if (q === null) setDrill(null)
  }, [])

  useEffect(() => {
    if (!drill || query !== '') return
    const back = (e: KeyboardEvent | null) => {
      e?.preventDefault()
      setDrill(null)
      return true
    }
    return mergeRegister(
      editor.registerCommand(KEY_BACKSPACE_COMMAND, back, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_LEFT_COMMAND, back, COMMAND_PRIORITY_CRITICAL),
    )
  }, [editor, drill, query])

  const onSelectOption = useCallback(
    (option: RowOption, textNode: TextNode | null, closeMenu: () => void) => {
      const row = option.row
      if (row.type === 'category' || row.type === 'see-all') {
        setDrill(row.drill ?? null)
        return
      }
      if (row.type === 'back') {
        setDrill(null)
        return
      }
      if (row.type === 'pick-date') {
        textNode?.remove()
        closeMenu()
        onRequestDatePicker?.()
        return
      }
      const token = row.candidate?.token
      const ref = token ? parseDocToken(token) : null
      if (!ref || !token) return
      $insertChip(ref, textNode)
      rememberMention(workspaceId, token)
      closeMenu()
    },
    [workspaceId, onRequestDatePicker],
  )

  return (
    <LexicalTypeaheadMenuPlugin<RowOption>
      options={options}
      onQueryChange={onQueryChange}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      menuRenderFn={(anchor, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchor.current && options.length
          ? createPortal(
              <div className={`sd-theme sd-menu${dark ? ' sd-dark' : ''}`} data-testid="doc-mention-menu" role="listbox">
                <div className="sd-menu-rows">
                  {options.map((option, i) => (
                    <MenuRow
                      key={option.key}
                      option={option}
                      selected={i === selectedIndex}
                      onHover={() => setHighlightedIndex(i)}
                      onPick={() => selectOptionAndCleanUp(option)}
                    />
                  ))}
                </div>
                {menu?.footer ? <div className="sd-menu-footer">{menu.footer}</div> : null}
              </div>,
              anchor.current,
            )
          : null
      }
    />
  )
}

const CATEGORY_GLYPHS: Record<MentionCategory, string> = {
  people: '👤',
  agents: '✦',
  groups: '👥',
  channels: '#',
  projects: '▤',
  dates: '▦',
  notify: '🔔',
}

function MenuRow({ option, selected, onHover, onPick }: { option: RowOption; selected: boolean; onHover: () => void; onPick: () => void }) {
  const row = option.row
  const glyph = row.type === 'back' ? '‹' : row.type === 'item' && row.candidate?.kind === 'channel' ? '#' : CATEGORY_GLYPHS[row.category]
  return (
    <>
      {row.section ? <div className="sd-menu-section">{row.section}</div> : null}
      <div
        ref={option.setRefElement}
        role="option"
        aria-selected={selected}
        data-testid={`doc-menu-row-${row.key}`}
        className={`sd-menu-row${selected ? ' sd-menu-row-selected' : ''}`}
        onMouseEnter={onHover}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
      >
        <span className="sd-menu-glyph" aria-hidden>
          {row.type === 'item' && row.candidate?.image ? <img src={row.candidate.image} alt="" /> : glyph}
        </span>
        <span className={`sd-menu-label${row.type === 'back' ? ' sd-menu-back' : ''}`}>{row.label}</span>
        {row.subtitle ? <span className="sd-menu-subtitle">{row.subtitle}</span> : <span className="sd-menu-spacer" />}
        {row.trailing ? <span className="sd-menu-trailing">{row.trailing}</span> : null}
        {selected && !row.drill && row.type !== 'back' ? <span className="sd-menu-enter">Enter</span> : null}
        {row.drill ? <span className="sd-menu-chevron">›</span> : null}
      </div>
    </>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const WEBVIEW_CSS = `
html, body { margin: 0; padding: 0; background: transparent; height: 100%; }
body { -webkit-text-size-adjust: 100%; }
`

const CSS = `
.sd-theme { --sd-fg: #0a0a0a; --sd-muted: #737373; --sd-border: #e5e5e5; --sd-bg: #ffffff; --sd-accent: #f4f4f5;
  --sd-chip: #e8f1fb; --sd-chip-fg: #1264a3; --sd-me: #fff3c4; --sd-me-fg: #6b4e00; --sd-primary: #2563eb; --sd-code: #f4f4f5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--sd-fg); }
.sd-theme.sd-dark { --sd-fg: #fafafa; --sd-muted: #a1a1aa; --sd-border: #27272a; --sd-bg: #18181b; --sd-accent: #27272a;
  --sd-chip: #1d2b3a; --sd-chip-fg: #8ec5ff; --sd-me: #4a3d10; --sd-me-fg: #ffe08a; --sd-primary: #60a5fa; --sd-code: #27272a; }
.sd-doc { display: flex; flex-direction: column; flex: 1; height: 100%; min-height: 0; box-sizing: border-box; }
.sd-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--sd-border); }
.sd-tool { border: 0; background: transparent; color: var(--sd-muted); font: inherit; font-size: 12px; min-width: 26px; height: 26px;
  border-radius: 6px; cursor: pointer; padding: 0 6px; }
.sd-tool:hover { background: var(--sd-accent); color: var(--sd-fg); }
.sd-tool-active { background: var(--sd-accent); color: var(--sd-fg); }
.sd-sep { width: 1px; height: 16px; background: var(--sd-border); margin: 0 4px; }
.sd-scroll { position: relative; flex: 1; min-height: 0; overflow-y: auto; }
.sd-content { outline: none; padding: 12px 16px 48px; font-size: 14px; line-height: 1.55; min-height: 100%; box-sizing: border-box; }
.sd-placeholder { position: absolute; top: 12px; left: 16px; right: 16px; color: var(--sd-muted); font-size: 14px; pointer-events: none; }
.sd-p { margin: 0 0 6px; }
.sd-h1 { font-size: 22px; font-weight: 700; margin: 14px 0 6px; }
.sd-h2 { font-size: 18px; font-weight: 700; margin: 12px 0 6px; }
.sd-h3 { font-size: 15px; font-weight: 700; margin: 10px 0 4px; }
.sd-h4 { font-size: 14px; font-weight: 700; margin: 8px 0 4px; }
.sd-quote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--sd-border); color: var(--sd-muted); }
.sd-ul, .sd-ol { margin: 0 0 6px; padding-left: 22px; }
.sd-li { margin: 2px 0; }
.sd-li-nested { list-style: none; }
.sd-li-checked, .sd-li-unchecked { position: relative; list-style: none; padding-left: 22px; margin-left: -22px; outline: none; }
.sd-li-checked::before, .sd-li-unchecked::before { content: ''; position: absolute; left: 0; top: 4px; width: 14px; height: 14px;
  border: 1px solid var(--sd-muted); border-radius: 3px; cursor: pointer; box-sizing: border-box; }
.sd-li-checked::before { background: var(--sd-primary); border-color: var(--sd-primary); }
.sd-li-checked::after { content: ''; position: absolute; left: 5px; top: 6px; width: 3px; height: 7px; border: solid #fff;
  border-width: 0 2px 2px 0; transform: rotate(45deg); pointer-events: none; }
.sd-li-checked { color: var(--sd-muted); text-decoration: line-through; }
.sd-b { font-weight: 700; }
.sd-i { font-style: italic; }
.sd-s { text-decoration: line-through; }
.sd-u { text-decoration: underline; }
.sd-code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--sd-code); padding: 1px 4px; border-radius: 4px; }
.sd-codeblock { display: block; font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--sd-code);
  padding: 8px 10px; border-radius: 6px; margin: 6px 0; white-space: pre-wrap; tab-size: 2; }
.sd-link { color: var(--sd-primary); text-decoration: underline; }
.sd-hr, .sd-content hr { border: 0; border-top: 1px solid var(--sd-border); margin: 12px 0; }
.sd-chip { display: inline-flex; align-items: center; gap: 3px; padding: 0 4px; border-radius: 4px; background: var(--sd-chip);
  color: var(--sd-chip-fg); font-weight: 500; cursor: pointer; user-select: none; white-space: nowrap; }
.sd-chip:hover { filter: brightness(0.96); }
.sd-chip-date { background: transparent; text-decoration: underline dotted; text-underline-offset: 3px; padding: 0 2px; }
.sd-chip-project { background: var(--sd-accent); color: var(--sd-fg); }
.sd-chip-me { background: var(--sd-me); color: var(--sd-me-fg); }
.sd-chip-unknown { background: var(--sd-accent); color: var(--sd-muted); font-style: italic; }
.sd-chip-selected { outline: 2px solid var(--sd-primary); outline-offset: 1px; }
.sd-chip-icon { font-size: 11px; opacity: 0.7; }
.sd-raw { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--sd-code); padding: 8px 10px;
  border-radius: 6px; margin: 6px 0; white-space: pre-wrap; }
.sd-table { border-collapse: collapse; margin: 6px 0; font-size: 13px; }
.sd-table th, .sd-table td { border: 1px solid var(--sd-border); padding: 4px 8px; text-align: left; }
.sd-table th { background: var(--sd-accent); font-weight: 600; }
.sd-menu { position: absolute; z-index: 1000; margin-top: 22px; width: 320px; max-width: calc(100vw - 16px); background: var(--sd-bg);
  border: 1px solid var(--sd-border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.16); overflow: hidden; font-size: 12px; }
.sd-menu-rows { max-height: 300px; overflow-y: auto; padding: 4px 0; }
.sd-menu-section { padding: 6px 12px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--sd-muted); }
.sd-menu-row { display: flex; align-items: center; gap: 8px; padding: 5px 12px; cursor: pointer; }
.sd-menu-row-selected { background: var(--sd-accent); }
.sd-menu-glyph { width: 20px; display: inline-flex; justify-content: center; color: var(--sd-muted); font-size: 12px; }
.sd-menu-glyph img { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; }
.sd-menu-label { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
.sd-menu-back { font-weight: 600; }
.sd-menu-subtitle { flex: 1; min-width: 0; color: var(--sd-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sd-menu-spacer { flex: 1; }
.sd-menu-trailing { color: var(--sd-muted); font-size: 10px; white-space: nowrap; }
.sd-menu-enter { font-size: 10px; color: var(--sd-muted); background: var(--sd-accent); border: 1px solid var(--sd-border); border-radius: 4px; padding: 0 4px; }
.sd-menu-chevron { color: var(--sd-muted); }
.sd-menu-footer { border-top: 1px solid var(--sd-border); padding: 6px 12px; color: var(--sd-muted); font-size: 11px; }
`
