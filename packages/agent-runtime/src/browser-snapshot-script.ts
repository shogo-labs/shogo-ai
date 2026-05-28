// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Accessibility-snapshot script body for the browser tool. Stored as a single
// template-literal string so chromium (not bun) runs the code. The string is
// passed to `page.evaluate(<source>)` from gateway-tools.ts. Keeping this body
// out of the executable TS source means the 100+ helper lines that ONLY ever
// run inside the page (V8 inside chromium, not node) don't inflate the
// gateway-tools.ts coverage denominator with structurally unreachable code.
//
// The body must remain plain JS (no TypeScript syntax). When editing:
//   - Do NOT add type annotations (no `: Element`, no `as HTMLInputElement`).
//   - The page injects `data-shogo-ref` attributes for interactive nodes.
//   - Returned shape: { text: string, refCount: number }
//
// Coverage policy: this file's source body is a single string literal — bun
// coverage counts it as one statement, not per-line. No istanbul-ignore is
// required.

export const ACCESSIBILITY_SNAPSHOT_SCRIPT = `(() => {
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'switch', 'tab', 'slider', 'spinbutton', 'searchbox',
  ])

  let nextRef = 1

  function getRole(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName
    if (tag === 'A' && el.hasAttribute('href')) return 'link'
    if (tag === 'BUTTON' || (tag === 'INPUT' && (el.type === 'submit' || el.type === 'button'))) return 'button'
    if (tag === 'INPUT') {
      const t = el.type
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'range') return 'slider'
      if (t === 'number') return 'spinbutton'
      if (t === 'search') return 'searchbox'
      return 'textbox'
    }
    if (tag === 'SELECT') return 'combobox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'IMG') return 'img'
    if (/^H[1-6]$/.test(tag)) return 'heading'
    if (tag === 'NAV') return 'navigation'
    if (tag === 'MAIN') return 'main'
    if (tag === 'HEADER') return 'banner'
    if (tag === 'FOOTER') return 'contentinfo'
    if (tag === 'ASIDE') return 'complementary'
    if (tag === 'FORM') return 'form'
    if (tag === 'TABLE') return 'table'
    if (tag === 'UL' || tag === 'OL') return 'list'
    if (tag === 'LI') return 'listitem'
    if (tag === 'SECTION' && el.getAttribute('aria-label')) return 'region'
    return ''
  }

  function getName(el) {
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel
    const title = el.getAttribute('title')
    if (title) return title
    const alt = el.getAttribute('alt')
    if (alt) return alt
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return placeholder
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]')
      if (label && label.textContent && label.textContent.trim()) return label.textContent.trim()
    }
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent && n.textContent.trim())
      .filter(Boolean)
      .join(' ')
    if (directText) return directText.substring(0, 80)
    if (el.children.length <= 2) {
      const inner = el.textContent && el.textContent.trim()
      if (inner && inner.length <= 80) return inner
    }
    return ''
  }

  function isVisible(el) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false
    const s = window.getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
  }

  function walk(el, depth) {
    if (!isVisible(el)) return []
    const role = getRole(el)
    const name = getName(el)
    const lines = []
    let childDepth = depth

    if (role) {
      const indent = '  '.repeat(depth)
      let line = indent + role
      if (name) line += ' "' + name + '"'

      const v = el.value
      if (v && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        line += ' value="' + v.substring(0, 80) + '"'
      }

      const attrs = []
      if (el.disabled) attrs.push('disabled')
      if (el.checked) attrs.push('checked')
      const expanded = el.getAttribute('aria-expanded')
      if (expanded !== null) attrs.push('expanded=' + expanded)
      if (el.getAttribute('aria-selected') === 'true') attrs.push('selected')
      if (el.getAttribute('aria-required') === 'true') attrs.push('required')
      if (attrs.length) line += ' [' + attrs.join(', ') + ']'

      const isInteractive = INTERACTIVE_TAGS.has(el.tagName) || INTERACTIVE_ROLES.has(role)
      if (isInteractive && !el.disabled) {
        const r = nextRef++
        el.setAttribute('data-shogo-ref', String(r))
        line += ' <ref=' + r + '>'
      }

      lines.push(line)
      childDepth = depth + 1
    }

    for (const child of el.children) {
      lines.push.apply(lines, walk(child, childDepth))
    }
    return lines
  }

  const lines = walk(document.body, 0)
  return { text: lines.join('\\n') || '(empty page)', refCount: nextRef - 1 }
})()`
