// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Single shared ANSI/OSC escape-sequence stripper for the terminal renderer.
 *
 * Previously copy-pasted in agent-terminal-bridge, terminal-persistence, and
 * output-streamer with subtly different regexes. This is the most complete of
 * those variants: it removes CSI (with private/intermediate bytes), OSC, DCS,
 * and charset-designation sequences.
 */
export function stripAnsi(data: string): string {
  return data
    // CSI: ESC [ ... final byte (covers colors, cursor moves, private modes).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] ... terminated by BEL or ST.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS: ESC P ... ST.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    // Charset designation: ESC ( / ESC ) followed by a set id.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][AB012]/g, '')
}
