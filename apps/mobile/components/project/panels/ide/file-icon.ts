// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Tailwind colour class for a file-extension icon (shared by Explorer + tabs). */
export function iconFor(ext: string) {
  if (["ts", "tsx"].includes(ext)) return "text-[#3178c6]";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "text-[#f7df1e]";
  if (ext === "json") return "text-[#cbcb41]";
  if (ext === "md") return "text-[#519aba]";
  if (ext === "css") return "text-[#42a5f5]";
  if (ext === "html") return "text-[#e44d26]";
  if (ext === "prisma") return "text-[#a78bfa]";
  if (ext === "py") return "text-[#3572a5]";
  return "text-[color:var(--ide-accent-file-icon)]";
}
