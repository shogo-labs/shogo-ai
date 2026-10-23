// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web-only escape hatch for react-native-web's inverted `FlatList`.
 *
 * RN-web patches `VirtualizedList` with a native `wheel` listener on the list's
 * scroll node (`setupWebWheelHandler` → `invertedWheelEventHandler`). That
 * handler measures scrollability on `ev.target` — the deepest element under the
 * pointer, usually a `<td>`, `<span>` or `<code>` — moves the list by `deltaY`
 * alone, and always calls `ev.preventDefault()`. Two things break:
 *
 *  - a **nested scroller** (the `overflow-x-auto overflow-y-auto` wrapper
 *    Streamdown puts around every table, a `max-h` code block) never receives
 *    the gesture: its own children are the event target, and `preventDefault`
 *    stops the browser from scrolling it;
 *  - a **horizontal** gesture (a trackpad swipe, or shift+wheel) carries no
 *    vertical delta, so the list does not move either and the event is
 *    swallowed whole — the pane looks frozen.
 *
 * `findNestedScroller` answers "does this gesture belong to something inside
 * the list?". The caller takes the event in the capture phase, stops RN-web's
 * listener from ever running, and moves that element instead. When the nested
 * scroller is already at the edge the helper finds nothing, so the same
 * gesture falls through to the timeline as it does today.
 */

/** Overflow values that make an element a scroll container. */
const SCROLLABLE = new Set(['auto', 'scroll', 'overlay'])
/** Sub-pixel slack: `scrollTop` is fractional on a scaled display. */
const EDGE_SLACK = 1

export interface WheelGesture {
  deltaX: number
  deltaY: number
  shiftKey: boolean
  /** 0 = pixels, 1 = lines, 2 = pages (Firefox reports lines). */
  deltaMode?: number
}

export interface WheelAxis {
  axis: 'x' | 'y'
  delta: number
}

/** Rough pixel size of a line and a page, for browsers that report those units. */
const LINE_PX = 16
const PAGE_PX = 800

/**
 * Which axis a wheel gesture should move, and by how much.
 *
 * The dominant delta wins, and shift turns a vertical wheel into a horizontal
 * one — the same convention browsers use for a mouse wheel held sideways.
 */
export function wheelAxis(gesture: WheelGesture): WheelAxis {
  const { deltaX, deltaY, shiftKey } = gesture
  if (shiftKey && Math.abs(deltaY) >= Math.abs(deltaX)) return { axis: 'x', delta: deltaY }
  if (Math.abs(deltaX) > Math.abs(deltaY)) return { axis: 'x', delta: deltaX }
  return { axis: 'y', delta: deltaY }
}

/** A gesture's travel in pixels. */
function pixels(gesture: WheelGesture): WheelAxis {
  const { axis, delta } = wheelAxis(gesture)
  const scale = gesture.deltaMode === 1 ? LINE_PX : gesture.deltaMode === 2 ? PAGE_PX : 1
  return { axis, delta: delta * scale }
}

function canMove(axis: 'x' | 'y', element: Element, delta: number): boolean {
  const range = axis === 'x'
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight
  if (range <= EDGE_SLACK) return false
  const position = axis === 'x' ? element.scrollLeft : element.scrollTop
  return delta < 0 ? position > EDGE_SLACK : position < range - EDGE_SLACK
}

/**
 * The nearest element under `target` that can move on the gesture's axis, or
 * null when the gesture belongs to the list itself.
 *
 * The walk stops *before* `boundary` — the list's own scroll node — so the
 * timeline keeps its (inverted) scrolling behaviour.
 */
export function findNestedScroller(
  target: Element | null,
  boundary: Element | null,
  gesture: WheelGesture,
): Element | null {
  const { axis, delta } = wheelAxis(gesture)
  if (!target || !boundary || delta === 0) return null
  const horizontal = axis === 'x'
  let element: Element | null = target
  while (element && element !== boundary) {
    const style = getComputedStyle(element)
    const overflow = horizontal ? style.overflowX : style.overflowY
    if (SCROLLABLE.has(overflow) && canMove(axis, element, delta)) return element
    element = element.parentElement
  }
  return null
}

/**
 * Hand wheel gestures over a nested scroller back to that element.
 *
 * Listens in the capture phase on a container *above* the list, so it runs
 * before RN-web's own listener; `getScrollNode` returns that listener's node,
 * which is where the walk stops. The scroll is applied here rather than left to
 * the browser: Chrome does not turn shift+wheel into horizontal scrolling for a
 * nested element, and the inverted list would take the gesture instead.
 * Returns the detach function.
 */
export function attachNestedWheelPassthrough(
  root: Element,
  getScrollNode: () => Element | null,
): () => void {
  const onWheel: EventListener = (event) => {
    const gesture = event as WheelEvent
    const boundary = getScrollNode()
    if (!boundary || !(gesture.target instanceof Element)) return
    const scroller = findNestedScroller(gesture.target, boundary, gesture)
    if (!scroller) return
    gesture.stopPropagation()
    gesture.preventDefault()
    const { axis, delta } = pixels(gesture)
    if (axis === 'x') scroller.scrollLeft += delta
    else scroller.scrollTop += delta
  }
  root.addEventListener('wheel', onWheel, { capture: true })
  return () => root.removeEventListener('wheel', onWheel, { capture: true })
}
