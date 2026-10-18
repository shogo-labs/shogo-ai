// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from "react"
import Svg, { Circle, Path, Rect, Text as SvgText } from "react-native-svg"
import { GLYPHS, badgeFontSize, fileTypeIconFor } from "./file-type-icon"

export function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  const spec = fileTypeIconFor(path)
  if (spec.kind === "badge") {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Rect x={1} y={1} width={14} height={14} rx={3} fill={spec.color} />
        <SvgText
          x={8}
          y={8 + badgeFontSize(spec.text) * 0.36}
          fill={spec.textColor}
          fontSize={badgeFontSize(spec.text)}
          fontWeight="700"
          textAnchor="middle"
        >
          {spec.text}
        </SvgText>
      </Svg>
    )
  }
  const shape = GLYPHS[spec.glyph]
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={spec.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape.paths.map((d) => (
        <Path key={d} d={d} />
      ))}
      {shape.circles?.map((c) => (
        <Circle key={`${c.cx},${c.cy}`} cx={c.cx} cy={c.cy} r={c.r} />
      ))}
    </Svg>
  )
}
