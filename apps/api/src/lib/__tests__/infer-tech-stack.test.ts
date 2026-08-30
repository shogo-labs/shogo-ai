// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { inferTechStackId, isKnownTechStackId } from '../infer-tech-stack'

function u8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('isKnownTechStackId', () => {
  test('accepts registry ids and rejects unknowns', () => {
    expect(isKnownTechStackId('expo-app')).toBe(true)
    expect(isKnownTechStackId('none')).toBe(true)
    expect(isKnownTechStackId('expo-cli-tools')).toBe(false)
    expect(isKnownTechStackId('')).toBe(false)
    expect(isKnownTechStackId(null)).toBe(false)
  })
})

describe('inferTechStackId', () => {
  test('settings.techStackId wins when it is a known id', () => {
    expect(
      inferTechStackId({
        settingsTechStackId: 'python-data',
        files: {
          'workspace/package.json': u8(JSON.stringify({ dependencies: { expo: '1' } })),
        },
      }),
    ).toBe('python-data')
  })

  test('ignores unknown settings ids and falls through to the marker', () => {
    expect(
      inferTechStackId({
        settingsTechStackId: 'totally-made-up',
        files: { 'workspace/.tech-stack': u8('expo-three\n') },
      }),
    ).toBe('expo-three')
  })

  test('keeps an explicit none rather than inferring from files', () => {
    expect(
      inferTechStackId({
        settingsTechStackId: 'none',
        files: {
          'workspace/package.json': u8(JSON.stringify({ dependencies: { expo: '1' } })),
        },
      }),
    ).toBe('none')
  })

  test('expo + expo-router package.json (no three) → expo-app', () => {
    expect(
      inferTechStackId({
        files: {
          'workspace/package.json': u8(
            JSON.stringify({
              dependencies: {
                expo: '~57.0.14',
                'expo-router': '~57.0.14',
                'react-native': '0.86.2',
              },
            }),
          ),
          'workspace/app.json': u8(JSON.stringify({ expo: { name: 'Singing' } })),
        },
      }),
    ).toBe('expo-app')
  })

  test('expo + three.js → expo-three', () => {
    expect(
      inferTechStackId({
        files: {
          'package.json': u8(
            JSON.stringify({
              dependencies: { expo: '1', '@react-three/fiber': '8', 'expo-gl': '14' },
            }),
          ),
        },
      }),
    ).toBe('expo-three')
  })

  test('react-native without expo → react-native', () => {
    expect(
      inferTechStackId({
        files: {
          'workspace/package.json': u8(
            JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }),
          ),
        },
      }),
    ).toBe('react-native')
  })

  test('phaser / three / python / unity file signals', () => {
    expect(
      inferTechStackId({
        files: { 'workspace/package.json': u8(JSON.stringify({ dependencies: { phaser: '3' } })) },
      }),
    ).toBe('phaser-game')
    expect(
      inferTechStackId({
        files: { 'workspace/package.json': u8(JSON.stringify({ dependencies: { three: '0.160' } })) },
      }),
    ).toBe('threejs-game')
    expect(
      inferTechStackId({ files: { 'workspace/requirements.txt': u8('numpy==1.0\n') } }),
    ).toBe('python-data')
    expect(
      inferTechStackId({
        files: { 'workspace/ProjectSettings/ProjectVersion.txt': u8('m_EditorVersion: 2022.3\n') },
      }),
    ).toBe('unity-game')
  })

  test('does not guess react-app for a generic workspace', () => {
    expect(
      inferTechStackId({
        files: {
          'workspace/README.md': u8('# hi\n'),
          'workspace/package.json': u8(JSON.stringify({ dependencies: { react: '19' } })),
        },
      }),
    ).toBeUndefined()
  })
})
