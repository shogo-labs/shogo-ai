// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Build a URL for a file served by an agent workspace proxy.
 *
 * Workspace paths use `/` as their separator, but each individual path
 * segment still needs encoding so names containing spaces, `#`, or `?` don't
 * change the request URL.
 */
export function buildAgentWorkspaceUrl(agentUrl: string, path: string): string {
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${agentUrl.replace(/\/+$/, "")}/agent/workspace/download/${encodedPath}`;
}
