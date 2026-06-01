// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Small identity helpers for the commit graph: deterministic avatar colors
// and initials, plus detection of Shogo-AI–authored commits (which get a
// distinct node in the graph, like GitKraken's bot avatars).

const AVATAR_COLORS = [
  "#1f9cf0",
  "#cf6edf",
  "#42c88a",
  "#f0883e",
  "#f14c4c",
  "#3ecfcf",
  "#e2c08d",
  "#7aa6ff",
  "#d18df0",
  "#5fb85f",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function avatarColor(seed: string): string {
  return AVATAR_COLORS[hashString(seed || "?") % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const cleaned = (name || "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AI_EMAILS = new Set(["ai@shogo.dev"]);
const AI_NAMES = new Set(["shogo ai", "shogo"]);

export function isAiAuthor(name: string, email: string): boolean {
  return (
    AI_EMAILS.has((email || "").toLowerCase()) ||
    AI_NAMES.has((name || "").trim().toLowerCase())
  );
}

export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
