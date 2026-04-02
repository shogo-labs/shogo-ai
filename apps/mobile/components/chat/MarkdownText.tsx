// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useMemo } from "react"
import Markdown from "react-native-marked"
import type { MarkedStyles } from "react-native-marked"
import { useColorScheme } from "nativewind"
import type { ColorValue } from "react-native"

interface ThemeColors {
  text: ColorValue
  code: ColorValue
  link: ColorValue
  border: ColorValue
}

export interface MarkdownTextProps {
  children: string
  className?: string
  isStreaming?: boolean
}

const baseStyles: MarkedStyles = {
  text: { fontSize: 12, lineHeight: 18 },
  strong: { fontWeight: "bold" },
  em: { fontStyle: "italic" },
  codespan: {
    fontFamily: "monospace",
    fontSize: 10,
    borderRadius: 3,
  },
  code: {
    borderRadius: 6,
    padding: 10,
  },
  h1: { fontSize: 16, fontWeight: "bold", marginBottom: 4 },
  h2: { fontSize: 14, fontWeight: "bold", marginBottom: 3 },
  h3: { fontSize: 12, fontWeight: "600", marginBottom: 2 },
  h4: { fontSize: 12, fontWeight: "500" },
  list: { marginVertical: 2 },
  li: { fontSize: 12, lineHeight: 18 },
  link: { textDecorationLine: "underline" },
  hr: { height: 1, marginVertical: 8 },
  image: { borderRadius: 6 },
}

const lightColors: ThemeColors = {
  text: "#1a1a1a",
  code: "#f5f5f5",
  link: "#2563eb",
  border: "#e0e0e0",
}

const darkColors: ThemeColors = {
  text: "#f0f0f0",
  code: "#2a2a2a",
  link: "#93c5fd",
  border: "#525252",
}

export function MarkdownText({ children }: MarkdownTextProps) {
  const { colorScheme } = useColorScheme()
  const colors = colorScheme === "dark" ? darkColors : lightColors

  const value = useMemo(() => children || "", [children])

  return (
    <Markdown
      value={value}
      styles={baseStyles}
      theme={{ colors }}
      flatListProps={{ scrollEnabled: false, style: { backgroundColor: 'transparent' } }}
    />
  )
}
