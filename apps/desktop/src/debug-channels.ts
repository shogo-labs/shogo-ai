// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Channel names only — importing this must not load the debug session module. */
export const DEBUG_IPC_CHANNELS = [
  'debug:start',
  'debug:setBreakpoint',
  'debug:removeBreakpoint',
  'debug:resume',
  'debug:pause',
  'debug:stepOver',
  'debug:stepInto',
  'debug:stepOut',
  'debug:evaluate',
  'debug:detach',
  'debug:list',
] as const
