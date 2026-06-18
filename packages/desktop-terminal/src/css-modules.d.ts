// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Ambient declaration so side-effect CSS imports (e.g. xterm's stylesheet)
// typecheck. These are resolved/bundled by the consuming web bundler at build
// time; TypeScript only needs to know the module exists.
declare module '*.css'
