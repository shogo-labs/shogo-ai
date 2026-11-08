// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The row a reopened chat shows while it rejoins a turn that is still running
 * (SHO-297, SHO-366).
 *
 * It sits under everything the chat has received so far — the half-written
 * reply included — so what the person read stays on screen and the row reads
 * as "more is coming" under it, rather than standing in the reply's place. The
 * words carry the same left → right shimmer as "Planning next moves" so the two
 * status lines look the same. It is replaced by the resume snapshot the moment
 * the window attaches.
 */
import { View } from "react-native"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { NATIVE_ACTIVITY_ROW } from "../NativeActivitySheet"
import { ShimmerLabel } from "./ShimmerLabel"

const LABEL = "Rejoining live reply…"

export function RejoinRow() {
  const nativePhone = useIsNativePhoneLayout()
  return (
    <View
      testID="chat-rejoining-row"
      accessibilityLabel="Rejoining live reply"
      aria-busy={true}
      className={nativePhone ? NATIVE_ACTIVITY_ROW : "pt-1 pb-2"}
    >
      <ShimmerLabel label={LABEL} />
    </View>
  )
}

export default RejoinRow
