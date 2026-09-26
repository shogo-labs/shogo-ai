// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useWindowDimensions } from "react-native"
import { getChatImageWidth } from "./image-sizing"

export function useChatImageWidth(min = 220, max = 320): number {
  const { width } = useWindowDimensions()
  return getChatImageWidth(width, min, max)
}
