// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server.ts',
    'src/react/index.ts',
    'src/native/index.ts',
    'src/route/index.ts',
    'src/route/signed-url.ts',
    'src/route/tts-preview.ts',
    'src/route/agent.ts',
    'src/route/audio-tags.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'es2020',
  outDir: 'dist',
  external: [
    'react',
    'react-native',
    '@ai-sdk/react',
    '@elevenlabs/react',
    '@elevenlabs/react-native',
    'ai',
    'three',
    'expo-gl',
    'expo-three',
  ],
})
