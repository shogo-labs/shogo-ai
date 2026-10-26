// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export type GenerateVideoStatus = "queued" | "in_progress" | "completed" | "failed";

export interface GenerateVideoResult {
  id?: string;
  job_id?: string;
  status?: GenerateVideoStatus;
  path?: string;
  planned_path?: string;
  model?: string;
  duration?: number;
  audio?: boolean;
  prompt?: string;
  bytes?: number;
  estimated_usd?: number;
  start_image?: string;
  message?: string;
  error?: string;
}

export function parseGenerateVideoResult(result: unknown): GenerateVideoResult | null {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  return result as GenerateVideoResult;
}

/** What the card should show for a finished tool call (or `rendering` while it runs). */
export function videoCardState(
  result: GenerateVideoResult | null,
  toolState: string | undefined,
): "rendering" | "ready" | "queued" | "failed" {
  if (result?.error || result?.status === "failed") return "failed";
  if (result?.path && result.status !== "queued" && result.status !== "in_progress") return "ready";
  if (toolState === "streaming" || !result) return "rendering";
  return "queued";
}
