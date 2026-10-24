// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SVG geometry for the huddle controls, for surfaces that render outside the
 * app's stylesheets — currently the picture-in-picture window, whose document
 * starts empty (see HuddlePip.tsx).
 *
 * The path data is copied verbatim from `lucide-react-native` v0.461.0 (ISC) —
 * the icon set `HuddleControls` draws — so the floating bar and the in-huddle
 * bar show the same glyph at the same optical weight. Regenerate from that
 * package rather than hand-editing, or the two bars drift apart again.
 */

export type PipIconNode = readonly [tag: string, attrs: Readonly<Record<string, string>>]

export const PIP_ICONS = {
  mic: [
    ['path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
    ['line', { x1: '12', x2: '12', y1: '19', y2: '22' }],
  ],
  micOff: [
    ['line', { x1: '2', x2: '22', y1: '2', y2: '22' }],
    ['path', { d: 'M18.89 13.23A7.12 7.12 0 0 0 19 12v-2' }],
    ['path', { d: 'M5 10v2a7 7 0 0 0 12 5' }],
    ['path', { d: 'M15 9.34V5a3 3 0 0 0-5.68-1.33' }],
    ['path', { d: 'M9 9v3a3 3 0 0 0 5.12 2.12' }],
    ['line', { x1: '12', x2: '12', y1: '19', y2: '22' }],
  ],
  video: [
    ['path', { d: 'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5' }],
    ['rect', { x: '2', y: '6', width: '14', height: '12', rx: '2' }],
  ],
  videoOff: [
    ['path', { d: 'M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196' }],
    ['path', { d: 'M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2' }],
    ['path', { d: 'm2 2 20 20' }],
  ],
  hand: [
    ['path', { d: 'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2' }],
    ['path', { d: 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2' }],
    ['path', { d: 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8' }],
    ['path', { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' }],
  ],
  thumbsUp: [
    ['path', { d: 'M7 10v12' }],
    ['path', { d: 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z' }],
  ],
  smile: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M8 14s1.5 2 4 2 4-2 4-2' }],
    ['line', { x1: '9', x2: '9.01', y1: '9', y2: '9' }],
    ['line', { x1: '15', x2: '15.01', y1: '9', y2: '9' }],
  ],
  maximize2: [
    ['polyline', { points: '15 3 21 3 21 9' }],
    ['polyline', { points: '9 21 3 21 3 15' }],
    ['line', { x1: '21', x2: '14', y1: '3', y2: '10' }],
    ['line', { x1: '3', x2: '10', y1: '21', y2: '14' }],
  ],
  phoneOff: [
    ['path', { d: 'M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91' }],
    ['line', { x1: '22', x2: '2', y1: '2', y2: '22' }],
  ],
} as const satisfies Record<string, readonly PipIconNode[]>

export type PipIconName = keyof typeof PIP_ICONS
