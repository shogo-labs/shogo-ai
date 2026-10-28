// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The horizontal placement a `ChatInput` gets, for a row rendered beside or
 * above a composer (for example, the typing indicator). Uses the same inputs
 * as `ChatInput`, so the row's edges match the input box's edges.
 */
import type { ViewStyle } from "react-native";
import {
  composerColumnStyle,
  type ChatColumnPresentation,
} from "../../../lib/chat-column";
import { useIsInsideChatColumn } from "../ChatColumn";
import { useComposerLayoutMode } from "./useComposerLayoutMode";

export function useComposerColumnStyle({
  presentation = "studio",
  flush = false,
}: {
  presentation?: ChatColumnPresentation;
  flush?: boolean;
} = {}): ViewStyle | undefined {
  const { isPhoneChrome, useProminentComposer } = useComposerLayoutMode({
    prominent: true,
    flush,
  });
  const insideChatColumn = useIsInsideChatColumn();
  return composerColumnStyle({
    presentation,
    phone: isPhoneChrome,
    prominent: useProminentComposer,
    flush,
    insideChatColumn,
  });
}
