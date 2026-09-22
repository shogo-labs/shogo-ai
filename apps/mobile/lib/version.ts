// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split(/[+-]/, 1)[0]
      .split(".")
      .map(Number)
      .concat([0, 0, 0])
      .slice(0, 3);
  const left = parse(a);
  const right = parse(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
