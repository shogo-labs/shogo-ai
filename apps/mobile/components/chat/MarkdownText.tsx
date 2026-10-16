// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { memo, useMemo, type ReactNode } from "react";
import Markdown, { Renderer } from "react-native-marked";
import type { MarkedStyles } from "react-native-marked";
import { useColorScheme } from "nativewind";
import {
  Linking,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type ColorValue,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { isMentionHref, linkifyBareUrls, linkifyFilePaths, pathFromFileHref } from "./file-links";
import { normalizeRichTextPaste } from "../../lib/rich-text-paste";
import { usePhoneLayout } from "../../lib/native-phone-layout";
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext";

/**
 * Semantic markdown palette. Light and dark values follow the GitHub gray
 * scale for structure, with an orange for inline code as the one accent.
 * Keep in sync with the `.chat-md` variables in `global.css` (web path).
 */
interface ThemeColors {
  text: ColorValue;
  heading: ColorValue;
  muted: ColorValue;
  link: ColorValue;
  codeText: ColorValue;
  codeBg: ColorValue;
  border: ColorValue;
  quoteBorder: ColorValue;
  tableHeaderBg: ColorValue;
  mentionBg: ColorValue;
  mentionText: ColorValue;
}

export type MarkdownVariant = "default" | "thinking";

export interface MarkdownTextProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  variant?: MarkdownVariant;
  /** Opens a workspace file when the text mentions its path. */
  onFilePress?: (path: string) => void;
  /** Return true to handle a link in the app instead of opening it in a browser. */
  onLinkPress?: (href: string) => boolean;
}

const baseStyles: MarkedStyles = {
  text: { fontSize: 12, lineHeight: 18 },
  strong: { fontSize: 12, lineHeight: 18, fontWeight: "bold" },
  em: { fontSize: 12, lineHeight: 18, fontStyle: "italic" },
  codespan: {
    fontFamily: "monospace",
    fontSize: 12,
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
  li: { fontSize: 12, lineHeight: 18 },
  link: { fontSize: 12, lineHeight: 18, textDecorationLine: "underline" },
  strikethrough: { fontSize: 12, lineHeight: 18 },
  hr: { height: 1, marginVertical: 8 },
  image: { borderRadius: 6 },
};

/** Larger, readable body copy for the phone chat surface. */
const phoneChatStyles: MarkedStyles = {
  ...baseStyles,
  text: { fontSize: 16, lineHeight: 24 },
  strong: { fontSize: 16, lineHeight: 24, fontWeight: "bold" },
  em: { fontSize: 16, lineHeight: 24, fontStyle: "italic" },
  link: { fontSize: 16, lineHeight: 24, textDecorationLine: "underline" },
  strikethrough: { fontSize: 16, lineHeight: 24 },
  h1: { fontSize: 18, lineHeight: 24, fontWeight: "bold", marginBottom: 6 },
  h2: { fontSize: 18, lineHeight: 24, fontWeight: "bold", marginBottom: 5 },
  h3: { fontSize: 18, lineHeight: 24, fontWeight: "600", marginBottom: 4 },
  h4: { fontSize: 18, lineHeight: 24, fontWeight: "500" },
  li: { fontSize: 16, lineHeight: 24 },
};

const thinkingStyles: MarkedStyles = {
  text: { fontSize: 14, lineHeight: 21 },
  strong: { fontSize: 14, lineHeight: 21, fontWeight: "bold" },
  em: { fontSize: 14, lineHeight: 21, fontStyle: "italic" },
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
  link: { fontSize: 14, lineHeight: 21, textDecorationLine: "underline" },
  strikethrough: { fontSize: 14, lineHeight: 21 },
  hr: { height: 1, marginVertical: 6 },
  image: { borderRadius: 6 },
};

const lightColors: ThemeColors = {
  text: "#1f2328",
  heading: "#111827",
  muted: "#59636e",
  link: "#0969da",
  codeText: "#b45309",
  codeBg: "#f6f8fa",
  border: "#d1d9e0",
  quoteBorder: "#d1d9e0",
  tableHeaderBg: "#f6f8fa",
  mentionBg: "#fef08a",
  mentionText: "#422006",
};

const darkColors: ThemeColors = {
  text: "#e6edf3",
  heading: "#ffffff",
  muted: "#8b949e",
  link: "#4493f8",
  codeText: "#fb923c",
  codeBg: "#161b22",
  border: "#30363d",
  quoteBorder: "#30363d",
  tableHeaderBg: "#161b22",
  mentionBg: "rgba(250, 204, 21, 0.3)",
  mentionText: "#fef9c3",
};

// Thinking blocks are de-emphasized, so the palette is desaturated and the
// text stays a step below the main body.
const lightThinkingColors: ThemeColors = {
  text: "#737373",
  heading: "#525252",
  muted: "#a3a3a3",
  link: "#6b9bd2",
  codeText: "#737373",
  codeBg: "#f0f0f0",
  border: "#e0e0e0",
  quoteBorder: "#e0e0e0",
  tableHeaderBg: "#f5f5f5",
  mentionBg: "#fef08a",
  mentionText: "#422006",
};

const darkThinkingColors: ThemeColors = {
  text: "#a0a0a0",
  heading: "#c4c4c4",
  muted: "#737373",
  link: "#7ba8d4",
  codeText: "#a0a0a0",
  codeBg: "#252525",
  border: "#444444",
  quoteBorder: "#444444",
  tableHeaderBg: "#2a2a2a",
  mentionBg: "rgba(250, 204, 21, 0.3)",
  mentionText: "#fef9c3",
};

/**
 * Layers semantic colors onto a size preset. The library reads `theme.colors`
 * for defaults, but element overrides win, so each element gets an explicit
 * color here.
 */
function withColors(sizes: MarkedStyles, c: ThemeColors): MarkedStyles {
  return {
    ...sizes,
    text: { ...sizes.text, color: c.text },
    strong: { ...sizes.strong, color: c.heading },
    em: { ...sizes.em, color: c.text },
    link: { ...sizes.link, color: c.link },
    strikethrough: { ...sizes.strikethrough, color: c.muted },
    li: { ...sizes.li, color: c.text },
    h1: { ...sizes.h1, color: c.heading },
    h2: { ...sizes.h2, color: c.heading },
    h3: { ...sizes.h3, color: c.heading },
    h4: { ...sizes.h4, color: c.heading },
    codespan: { ...sizes.codespan, color: c.codeText, backgroundColor: c.codeBg },
    blockquote: {
      ...sizes.blockquote,
      borderLeftWidth: 3,
      borderLeftColor: c.quoteBorder,
      paddingLeft: 12,
    },
    hr: { ...sizes.hr, borderBottomColor: c.border },
    table: { ...sizes.table, borderColor: c.border },
  };
}

/**
 * Same per-column width as `react-native-marked`'s `getTableWidthArr`
 * (`viewport * 1.3 / 3`). Keep this in lockstep so native tables match
 * the library's layout, with nested scrolling enabled on top.
 */
const MARKED_TABLE_COLUMN_WIDTH_RATIO = 1.3 / 3;

/**
 * Tables need their own horizontal gesture recognizer. The default
 * react-native-marked renderer already puts tables in a horizontal
 * ScrollView, but it does not enable nested scrolling; on a phone the
 * parent chat ScrollView can therefore consume the gesture and leave the
 * right side of a wide table inaccessible.
 */
class NativePhoneMarkdownRenderer extends Renderer {
  constructor(
    private readonly tableWidth: number,
    private readonly tableHeaderBg: ColorValue,
    private readonly mentionColors: { bg: ColorValue; text: ColorValue },
    private readonly onFilePress?: (path: string) => void,
    private readonly onLinkPress?: (href: string) => boolean,
  ) {
    super();
  }

  override link(
    children: string | ReactNode[],
    href: string,
    styles?: TextStyle,
    title?: string,
  ): ReactNode {
    if (isMentionHref(href)) {
      return (
        <Text
          selectable
          testID="chat-mention"
          key={this.getKey()}
          style={[
            styles,
            {
              textDecorationLine: "none",
              fontWeight: "600",
              color: this.mentionColors.text,
              backgroundColor: this.mentionColors.bg,
              borderRadius: 4,
            },
          ]}
        >
          {children}
        </Text>
      );
    }
    const path = pathFromFileHref(href);
    if (path && this.onFilePress) {
      const open = this.onFilePress;
      return (
        <Text
          selectable
          accessibilityRole="link"
          accessibilityLabel={title || path}
          testID="chat-file-link"
          key={this.getKey()}
          onPress={() => open(path)}
          style={styles}
        >
          {children}
        </Text>
      );
    }
    const handle = this.onLinkPress;
    if (handle) {
      return (
        <Text
          selectable
          accessibilityRole="link"
          key={this.getKey()}
          onPress={() => {
            if (!handle(href)) void Linking.openURL(href).catch(() => {});
          }}
          style={styles}
        >
          {children}
        </Text>
      );
    }
    return super.link(children, href, styles, title);
  }

  override table(
    header: ReactNode[][],
    rows: ReactNode[][][],
    tableStyle?: ViewStyle,
    rowStyle?: ViewStyle,
    cellStyle?: ViewStyle
  ): ReactNode {
    const columnWidth = Math.floor(
      this.tableWidth * MARKED_TABLE_COLUMN_WIDTH_RATIO
    );
    const widthArr = Array(header.length).fill(columnWidth);
    const borderStyle = {
      borderColor: tableStyle?.borderColor as string | undefined,
      borderWidth: tableStyle?.borderWidth,
    };

    return (
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator
        contentContainerStyle={tableStyle}
      >
        <View style={[tableStyle, borderStyle]}>
          <View
            style={[
              { flexDirection: "row", backgroundColor: this.tableHeaderBg },
              rowStyle,
            ]}
          >
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
            <View
              key={`row-${rowIndex}`}
              style={[{ flexDirection: "row" }, rowStyle]}
            >
              {row.map((cell, cellIndex) => (
                <View
                  key={`cell-${rowIndex}-${cellIndex}`}
                  style={[
                    { width: widthArr[cellIndex] },
                    cellStyle,
                    borderStyle,
                  ]}
                >
                  {cell}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
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
function markdownPropsEqual(prev: MarkdownTextProps, next: MarkdownTextProps) {
  if (prev.variant !== next.variant) return false;
  if (prev.className !== next.className) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.onFilePress !== next.onFilePress) return false;
  if (prev.onLinkPress !== next.onLinkPress) return false;
  const a = prev.children || "";
  const b = next.children || "";
  return a.length === b.length && a === b;
}

export const MarkdownText = memo(function MarkdownText({
  children,
  variant = "default",
  onFilePress,
  onLinkPress,
}: MarkdownTextProps) {
  const { colorScheme } = useColorScheme();
  const { width } = useWindowDimensions();
  const isPhoneLayout = usePhoneLayout();
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome();

  const isThinking = variant === "thinking";
  const colors =
    colorScheme === "dark"
      ? isThinking
        ? darkThinkingColors
        : darkColors
      : isThinking
      ? lightThinkingColors
      : lightColors;
  const sizeStyles = isThinking
    ? thinkingStyles
    : isPhoneLayout || usesMobileWorkspaceChrome
    ? phoneChatStyles
    : baseStyles;
  const styles = useMemo(
    () => withColors(sizeStyles, colors),
    [sizeStyles, colors],
  );
  // Library defaults for anything not styled above (e.g. image placeholders).
  const libraryTheme = useMemo(
    () => ({
      colors: {
        text: colors.text,
        code: colors.codeBg,
        link: colors.link,
        border: colors.border,
      },
    }),
    [colors],
  );

  const value = useMemo(() => {
    const normalized = normalizeRichTextPaste(children || "");
    const fileLinked = onFilePress ? linkifyFilePaths(normalized) : normalized;
    return linkifyBareUrls(fileLinked);
  }, [children, onFilePress]);
  const mentionColors = useMemo(
    () => ({ bg: colors.mentionBg, text: colors.mentionText }),
    [colors.mentionBg, colors.mentionText],
  );
  const renderer = useMemo(
    () =>
      new NativePhoneMarkdownRenderer(
        width,
        colors.tableHeaderBg,
        mentionColors,
        onFilePress,
        onLinkPress,
      ),
    [width, colors.tableHeaderBg, mentionColors, onFilePress, onLinkPress],
  );

  return (
    <Markdown
      value={value}
      styles={styles}
      theme={libraryTheme}
      renderer={renderer}
      flatListProps={{
        scrollEnabled: false,
        style: { backgroundColor: "transparent" },
      }}
    />
  );
},
markdownPropsEqual);
