// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

const NOISY_VM_PATTERNS = [
  /^-+BEGIN SSH/,
  /^-+END SSH/,
  /^ssh-(rsa|ed25519|ecdsa)/,
  /^ecdsa-sha2-/,
  /^#{3,}/,
  /^ci-info:/,
  /SHA256:/,
  /^Ubuntu .* LTS/,
]

export function isNoisyVMLine(line: string): boolean {
  return NOISY_VM_PATTERNS.some((p) => p.test(line))
}
