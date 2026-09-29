// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Return the parent path used by the remote directory browse endpoint. */
export function getRemoteParentPath(path: string): string | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "~" || normalized === "/") return null;

  if (normalized.startsWith("~/")) {
    const slash = normalized.lastIndexOf("/");
    return slash <= 1 ? "~" : normalized.slice(0, slash);
  }

  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}
