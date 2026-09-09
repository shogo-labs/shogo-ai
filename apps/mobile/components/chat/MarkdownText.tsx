// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { memo, useMemo, type ReactNode } from "react"
import Markdown, { Renderer } from "react-native-marked"
import type { MarkedStyles } from "react-native-marked"
import { useColorScheme } from "nativewind"
import { ScrollView, useWindowDimensions, View, type ColorValue, type ViewStyle } from "react-native"

interface ThemeColors {
  text: ColorValue
  code: ColorValue
  link: ColorValue
  border: ColorValue
}

export type MarkdownVariant = "default" | "thinking"

export interface MarkdownTextProps {
  children: string
  className?: string
  isStreaming?: boolean
  variant?: MarkdownVariant
}

const baseStyles: MarkedStyles = {
  text: { fontSize: 16, lineHeight: 23 },
  strong: { fontWeight: "bold" },
  em: { fontStyle: "italic" },
  codespan: {
    fontFamily: "monospace",
    fontSize: 14,
    borderRadius: 3,
  },
  code: {
    borderRadius: 6,
    padding: 10,
  },
  h1: { fontSize: 22, lineHeight: 28, fontWeight: "bold", marginBottom: 6 },
  h2: { fontSize: 20, lineHeight: 26, fontWeight: "bold", marginBottom: 5 },
  h3: { fontSize: 18, lineHeight: 24, fontWeight: "600", marginBottom: 4 },
  h4: { fontSize: 16, lineHeight: 22, fontWeight: "500" },
  list: { marginVertical: 2 },
  li: { fontSize: 16, lineHeight: 23 },
  link: { textDecorationLine: "underline" },
  hr: { height: 1, marginVertical: 8 },
  image: { borderRadius: 6 },
}

const thinkingStyles: MarkedStyles = {
  text: { fontSize: 14, lineHeight: 21 },
  strong: { fontWeight: "bold" },
  em: { fontStyle: "italic" },
  codespan: {
    fontFamily: "monospace",
    fontSize: 12,
    borderRadius: 3,
  },
  code: {
    borderRadius: 6,
    padding: 8,
  },
  h1: { fontSize: 19, lineHeight: 25, fontWeight: "bold", marginBottom: 4 },
  h2: { fontSize: 17, lineHeight: 23, fontWeight: "bold", marginBottom: 3 },
  h3: { fontSize: 15, lineHeight: 21, fontWeight: "600", marginBottom: 2 },
  h4: { fontSize: 14, lineHeight: 20, fontWeight: "500" },
  list: { marginVertical: 2 },
  li: { fontSize: 14, lineHeight: 21 },
  link: { textDecorationLine: "underline" },
  hr: { height: 1, marginVertical: 6 },
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

const lightThinkingColors: ThemeColors = {
  text: "#737373",
  code: "#f0f0f0",
  link: "#6b9bd2",
  border: "#e0e0e0",
}

const darkThinkingColors: ThemeColors = {
  text: "#a0a0a0",
  code: "#252525",
  link: "#7ba8d4",
  border: "#444444",
}

/**
 * Same per-column width as `react-native-marked`'s `getTableWidthArr`
 * (`viewport * 1.3 / 3`). Keep this in lockstep so native tables match
 * the library's layout, with nested scrolling enabled on top.
 */
const MARKED_TABLE_COLUMN_WIDTH_RATIO = 1.3 / 3

/**
 * Tables need their own horizontal gesture recognizer. The default
 * react-native-marked renderer already puts tables in a horizontal
 * ScrollView, but it does not enable nested scrolling; on a phone the
 * parent chat ScrollView can therefore consume the gesture and leave the
 * right side of a wide table inaccessible.
 */
class NativePhoneMarkdownRenderer extends Renderer {
  constructor(private readonly tableWidth: number) {
    super()
  }

  override table(
    header: ReactNode[][],
    rows: ReactNode[][][],
    tableStyle?: ViewStyle,
    rowStyle?: ViewStyle,
    cellStyle?: ViewStyle,
  ): ReactNode {
    const columnWidth = Math.floor(this.tableWidth * MARKED_TABLE_COLUMN_WIDTH_RATIO)
    const widthArr = Array(header.length).fill(columnWidth)
    const borderStyle = {
      borderColor: tableStyle?.borderColor as string | undefined,
      borderWidth: tableStyle?.borderWidth,
    }

    return (
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator
        contentContainerStyle={tableStyle}
      >
        <View style={[tableStyle, borderStyle]}>
          <View style={[{ flexDirection: "row" }, rowStyle]}>
            {header.map((headerCell, index) => (
              <View
                key={`header-${index}`}
                style={[{ width: widthArr[index] }, cellStyle, borderStyle]}
              >
                {headerCell}
              </View>
            ))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={[{ flexDirection: "row" }, rowStyle]}>
              {row.map((cell, cellIndex) => (
                <View
                  key={`cell-${rowIndex}-${cellIndex}`}
                  style={[{ width: widthArr[cellIndex] }, cellStyle, borderStyle]}
                >
                  {cell}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    )
  }
}

// `react-native-marked` re-parses the entire markdown body on every render, so
// the streaming hot path on iOS / Android pays a parse cost for every token
// even when neither the children string nor the variant changed (the parent
// `AssistantContent` re-renders on each commit, which flows down here even
// when the parts array reference was only swapped because a *different* part
// further up the message changed).
//
// String comparison in JS is value-equal, so `prev.children === next.children`
// returns true whenever the rendered text is identical — even across
// reference-different allocations. We can short-circuit on length first to
// keep the common "still streaming, body grew" case from doing a full
// character compare on long bodies.
function markdownPropsEqual(
  prev: MarkdownTextProps,
  next: MarkdownTextProps,
) {
  if (prev.variant !== next.variant) return false
  if (prev.className !== next.className) return false
  if (prev.isStreaming !== next.isStreaming) return false
  const a = prev.children || ""
  const b = next.children || ""
  return a.length === b.length && a === b
}

export const MarkdownText = memo(function MarkdownText({
  children,
  variant = "default",
}: MarkdownTextProps) {
  const { colorScheme } = useColorScheme()
  const { width } = useWindowDimensions()

  const isThinking = variant === "thinking"
  const colors = colorScheme === "dark"
    ? (isThinking ? darkThinkingColors : darkColors)
    : (isThinking ? lightThinkingColors : lightColors)
  const styles = isThinking ? thinkingStyles : baseStyles

  const value = useMemo(() => children || "", [children])
  const renderer = useMemo(
    () => new NativePhoneMarkdownRenderer(width),
    [width],
  )

  return (
    <Markdown
      value={value}
      styles={styles}
      theme={{ colors }}
      renderer={renderer}
      flatListProps={{ scrollEnabled: false, style: { backgroundColor: 'transparent' } }}
    />
  )
}, markdownPropsEqual)
