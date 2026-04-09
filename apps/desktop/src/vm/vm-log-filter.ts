// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Strip kernel timestamp and process prefixes from a VM console line.
 * e.g. "[    6.715714] cloud-init[622]: ci-info: ..." → "ci-info: ..."
 */
function stripVMPrefix(line: string): string {
  return line
    .replace(/^\[\s*[\d.]+\]\s*/, '')
    .replace(/^cloud-init\[\d+\]:\s*/, '')
    .replace(/^\(\d+\.\d+s\)\s*/, '')
}

const NOISY_VM_PATTERNS = [
  // SSH key generation
  /^-+BEGIN SSH/,
  /^-+END SSH/,
  /^ssh-(rsa|ed25519|ecdsa)/,
  /^ecdsa-sha2-/,
  /SHA256:/,
  /^Generating public\/private/,
  /^Your identification has been saved/,
  /^Your public key has been saved/,
  /^The key fingerprint is/,
  /^The key's randomart image is/,
  /^\+---\[/,
  /^\+----\[/,
  /^\|.*\|$/,

  // Cloud-init lifecycle
  /^Cloud-init v\./,
  /^ci-info:/,

  // Kernel/boot noise
  /^Ubuntu .* LTS/,
  /^#{3,}/,
  /^NOCHANGE:/,
  /^growpart:/,
  /login:\s*$/,

  // Disk resize
  /^resize2fs /,
  /^The filesystem on/,
]

export function isNoisyVMLine(line: string): boolean {
  const stripped = stripVMPrefix(line)
  return NOISY_VM_PATTERNS.some((p) => p.test(stripped))
}
