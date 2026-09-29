// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface AgentImageSource {
  uri: string;
  headers?: Record<string, string>;
}

export function createAgentImageSource(
  uri: string,
  platform: string,
  cookie?: string | null,
): AgentImageSource {
  if (platform === "web") return { uri };
  return cookie ? { uri, headers: { Cookie: cookie } } : { uri };
}
