// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Text, View } from "react-native"
import type { CredentialUse } from "../tools/types"

/** Short label for which account a tool call used: "as @bob", "project account · for Gina". */
export function credentialLabel(use: CredentialUse): string {
  if (use.source === "shared") return use.onBehalfOf ? `project account · for ${use.onBehalfOf}` : "project account"
  if (use.source === "approved") return `as ${use.actingAs} · approved`
  if (use.source === "delegate") return `as ${use.actingAs} · delegate`
  return `as ${use.actingAs}`
}

function credentialDescription(use: CredentialUse): string {
  switch (use.source) {
    case "shared":
      return `Ran with the shared ${use.actingAs}${use.onBehalfOf ? ` on behalf of ${use.onBehalfOf}` : ""}`
    case "approved":
      return `Ran as ${use.actingAs}, who approved it`
    case "delegate":
      return `Ran as ${use.actingAs}, who this agent acts as when no one else can be`
    default:
      return `Ran as ${use.actingAs}, the person who asked`
  }
}

export function CredentialChip({ credential }: { credential?: CredentialUse }) {
  if (!credential) return null
  return (
    <View
      accessible
      accessibilityLabel={credentialDescription(credential)}
      className="shrink-0 rounded-full border border-border/60 px-1.5 py-px"
    >
      <Text className="text-[9px] font-medium text-muted-foreground" numberOfLines={1}>
        {credentialLabel(credential)}
      </Text>
    </View>
  )
}
