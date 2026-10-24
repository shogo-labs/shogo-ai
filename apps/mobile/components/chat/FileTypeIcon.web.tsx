// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from "react"
import { GLYPHS, badgeFontSize, fileTypeIconFor } from "./file-type-icon"

export function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  const spec = fileTypeIconFor(path)
  if (spec.kind === "badge") {
    // The label is CSS-generated (`.file-type-badge::before`) so it stays out
    // of the link text and out of copied message text.
    return (
      <span
        aria-hidden="true"
        className="file-type-badge"
        data-file-icon={spec.text}
        style={{
          width: size * 0.875,
          height: size * 0.875,
          margin: size * 0.0625,
          fontSize: (badgeFontSize(spec.text) / 16) * size,
          backgroundColor: spec.color,
          color: spec.textColor,
        }}
      />
    )
  }
  const shape = GLYPHS[spec.glyph]
  return (
    <svg
      aria-hidden="true"
      data-file-icon={spec.glyph}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={spec.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape.paths.map((d) => (
        <path key={d} d={d} />
      ))}
      {shape.circles?.map((c) => (
        <circle key={`${c.cx},${c.cy}`} cx={c.cx} cy={c.cy} r={c.r} />
      ))}
    </svg>
  )
}
