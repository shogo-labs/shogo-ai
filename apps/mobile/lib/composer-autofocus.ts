// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Opening a channel or DM should leave you ready to type.
 *
 * Web only, deliberately. Slack puts the caret in the message box when you
 * open a conversation on the desktop, but does NOT raise the keyboard when you
 * open one on a phone — there, tapping a channel is usually a request to
 * *read*, and popping the keyboard costs a dismiss before you can even scroll.
 *
 * A composer you cannot post to is skipped too: focusing a read-only box would
 * promise typing that cannot happen.
 */
export function composerAutofocusesOnOpen(opts: {
  platform: string;
  canPost: boolean;
}): boolean {
  return opts.platform === "web" && opts.canPost;
}
