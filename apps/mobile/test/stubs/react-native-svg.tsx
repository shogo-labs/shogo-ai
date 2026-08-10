// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Test-only stub for `react-native-svg`.
 *
 * The real package cannot be evaluated in this environment: it reaches into
 * Flow-typed React Native internals (`Libraries/Utilities/codegenNativeComponent`),
 * which Bun's parser rejects outright, and it reads native module shapes at
 * import time. Because a dozen app components import it directly, that failure
 * surfaced as an unhandled error in suites that never render a chart or logo.
 *
 * Every element renders a plain `<div>` that passes its children through, so
 * text inside `<Text>` stays queryable; SVG geometry is not something these
 * suites assert on. Presentational props are dropped rather than forwarded,
 * since attributes like `strokeLinecap` are not valid on a `div`.
 */

import * as React from 'react'

type StubProps = { children?: React.ReactNode; testID?: string }

function stub(displayName: string) {
  const C = ({ children, testID }: StubProps) =>
    React.createElement('div', { 'data-testid': testID, 'data-svg': displayName }, children)
  C.displayName = displayName
  return C
}

export const Svg = stub('Svg')
export const Circle = stub('Circle')
export const Ellipse = stub('Ellipse')
export const G = stub('G')
export const Text = stub('Text')
export const TSpan = stub('TSpan')
export const TextPath = stub('TextPath')
export const Path = stub('Path')
export const Polygon = stub('Polygon')
export const Polyline = stub('Polyline')
export const Line = stub('Line')
export const Rect = stub('Rect')
export const Use = stub('Use')
export const Image = stub('Image')
export const Symbol = stub('Symbol')
export const Defs = stub('Defs')
export const LinearGradient = stub('LinearGradient')
export const RadialGradient = stub('RadialGradient')
export const Stop = stub('Stop')
export const ClipPath = stub('ClipPath')
export const Pattern = stub('Pattern')
export const Mask = stub('Mask')
export const Marker = stub('Marker')
export const ForeignObject = stub('ForeignObject')
export const SvgXml = stub('SvgXml')
export const SvgUri = stub('SvgUri')

export default Svg
