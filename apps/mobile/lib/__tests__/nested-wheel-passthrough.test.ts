// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The wheel passthrough that lets a markdown table or code block inside the
 * inverted team-chat timeline scroll on both axes (SHO-162).
 */

import { describe, expect, test } from 'bun:test'
import { findNestedScroller, wheelAxis } from '../nested-wheel-passthrough'

/** A div with a scroll box (jsdom has no layout, so the metrics are defined). */
function box(options: {
  overflow?: 'auto' | 'scroll' | 'visible' | 'hidden'
  width?: number
  scrollWidth?: number
  height?: number
  scrollHeight?: number
  scrollLeft?: number
  scrollTop?: number
}): HTMLDivElement {
  const element = document.createElement('div')
  const { overflow = 'auto', width = 300, scrollWidth = 300, height = 200, scrollHeight = 200 } = options
  element.style.overflowX = overflow
  element.style.overflowY = overflow
  const metrics = {
    clientWidth: width,
    scrollWidth,
    clientHeight: height,
    scrollHeight,
    scrollLeft: options.scrollLeft ?? 0,
    scrollTop: options.scrollTop ?? 0,
  }
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { value, configurable: true, writable: true })
  }
  return element
}

/** The list's own scroll node, holding the given content. */
function timeline(...content: HTMLElement[]): HTMLDivElement {
  const scrollNode = box({ height: 300, scrollHeight: 3000 })
  scrollNode.append(...content)
  document.body.append(scrollNode)
  return scrollNode
}

/** A Streamdown table wrapper: wider than its pane, never taller. */
function table(hidden: number, tall = 0) {
  const wrapper = box({ width: 300, scrollWidth: 300 + hidden, height: 200, scrollHeight: 200 + tall })
  const cell = document.createElement('td')
  wrapper.append(cell)
  return { wrapper, cell }
}

/** A code block with a max height: taller than its pane. */
function codeBlock(scrollHeight = 900) {
  const pre = box({ height: 160, scrollHeight })
  const code = document.createElement('code')
  pre.append(code)
  return { pre, code }
}

const vertical = (deltaY: number) => ({ deltaX: 0, deltaY, shiftKey: false })
const sideways = (deltaX: number) => ({ deltaX, deltaY: 0, shiftKey: false })

describe('wheelAxis', () => {
  test('a vertical wheel stays vertical', () => {
    expect(wheelAxis({ deltaX: 0, deltaY: 120, shiftKey: false })).toEqual({ axis: 'y', delta: 120 })
    expect(wheelAxis({ deltaX: -3, deltaY: -120, shiftKey: false })).toEqual({ axis: 'y', delta: -120 })
  })

  test('a trackpad swipe follows its dominant axis', () => {
    expect(wheelAxis({ deltaX: 90, deltaY: 4, shiftKey: false })).toEqual({ axis: 'x', delta: 90 })
    expect(wheelAxis({ deltaX: -90, deltaY: 4, shiftKey: false })).toEqual({ axis: 'x', delta: -90 })
    expect(wheelAxis({ deltaX: 4, deltaY: 90, shiftKey: false })).toEqual({ axis: 'y', delta: 90 })
  })

  test('shift turns a mouse wheel into a horizontal one', () => {
    expect(wheelAxis({ deltaX: 0, deltaY: 120, shiftKey: true })).toEqual({ axis: 'x', delta: 120 })
  })

  test('shift does not flip an already-horizontal gesture', () => {
    expect(wheelAxis({ deltaX: -90, deltaY: 0, shiftKey: true })).toEqual({ axis: 'x', delta: -90 })
  })
})

describe('findNestedScroller', () => {
  test('a wide table takes a horizontal swipe from a cell inside it', () => {
    const { cell, wrapper } = table(200)
    expect(findNestedScroller(cell, timeline(wrapper), sideways(90))).toBe(wrapper)
  })

  test('shift+wheel scrolls the table sideways too', () => {
    const { cell, wrapper } = table(200)
    expect(findNestedScroller(cell, timeline(wrapper), { deltaX: 0, deltaY: 120, shiftKey: true })).toBe(wrapper)
  })

  test('a tall code block takes a vertical wheel from the code inside it', () => {
    const { code, pre } = codeBlock()
    pre.scrollTop = 200
    const boundary = timeline(pre)
    expect(findNestedScroller(code, boundary, vertical(120))).toBe(pre)
    expect(findNestedScroller(code, boundary, vertical(-120))).toBe(pre)
  })

  test('the nearest scroller wins, not an outer one', () => {
    const { cell, wrapper } = table(200)
    const outer = box({ height: 200, scrollHeight: 900 })
    outer.append(wrapper)
    expect(findNestedScroller(cell, timeline(outer), sideways(90))).toBe(wrapper)
  })

  test('an element already at the edge of its travel is skipped', () => {
    const { cell, wrapper } = table(200)
    wrapper.scrollLeft = wrapper.scrollWidth - wrapper.clientWidth
    const boundary = timeline(wrapper)
    expect(findNestedScroller(cell, boundary, sideways(90))).toBeNull()
    expect(findNestedScroller(cell, boundary, sideways(-90))).toBe(wrapper)

    const { code, pre } = codeBlock()
    pre.scrollTop = pre.scrollHeight - pre.clientHeight
    const second = timeline(pre)
    expect(findNestedScroller(code, second, vertical(120))).toBeNull()
    expect(findNestedScroller(code, second, vertical(-120))).toBe(pre)
  })

  test('plain content inside the list belongs to the list', () => {
    const paragraph = document.createElement('p')
    const boundary = timeline(paragraph)
    expect(findNestedScroller(paragraph, boundary, vertical(120))).toBeNull()
    expect(findNestedScroller(paragraph, boundary, sideways(120))).toBeNull()
  })

  test('a wrapper without overflow on the gesture axis is skipped', () => {
    // A wide table wrapper never scrolls vertically, so a vertical wheel is
    // the timeline's.
    const { cell, wrapper } = table(200)
    expect(findNestedScroller(cell, timeline(wrapper), vertical(120))).toBeNull()
  })

  test('a scroll container with nothing to scroll is skipped', () => {
    const { cell, wrapper } = table(0)
    expect(findNestedScroller(cell, timeline(wrapper), sideways(90))).toBeNull()
  })

  test('never returns the list scroll node itself', () => {
    const boundary = timeline()
    const child = document.createElement('span')
    boundary.append(child)
    expect(findNestedScroller(child, boundary, vertical(120))).toBeNull()
    expect(findNestedScroller(boundary, boundary, vertical(120))).toBeNull()
  })

  test('a zero delta moves nothing', () => {
    const { cell } = table(200)
    expect(findNestedScroller(cell, timeline(), { deltaX: 0, deltaY: 0, shiftKey: false })).toBeNull()
  })

  test('a target outside the tree is ignored', () => {
    const { cell } = table(200)
    const boundary = timeline()
    expect(findNestedScroller(null, boundary, sideways(90))).toBeNull()
    expect(findNestedScroller(cell, null, sideways(90))).toBeNull()
  })
})
