// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface GenerateImageResult {
  path?: string;
  paths?: string[];
  size?: string;
  model?: string;
  quality?: string;
  bytes?: number;
  revised_prompt?: string;
  revised_prompts?: string[];
  reference_image?: string;
  error?: string;
}

export function parseGenerateImageResult(
  result: unknown,
): GenerateImageResult | null {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  return result as GenerateImageResult;
}

export function getGenerateImagePaths(
  result: GenerateImageResult | null,
): string[] {
  if (!result) return [];
  if (Array.isArray(result.paths) && result.paths.length > 0) {
    return result.paths.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
  }
  return result.path ? [result.path] : [];
}
