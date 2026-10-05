// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Microphone access for the web voice hooks.
 *
 * In the Electron desktop app, macOS gates the mic separately from Chromium:
 * the host bridge (`window.shogoDesktop.ensureMicAccess`) triggers the system
 * prompt up front. Failures are mapped to a message a person can act on
 * instead of the raw DOMException name.
 */

export const MIC_BLOCKED_MESSAGE =
  'Microphone access is blocked. Allow it in your system or browser settings (on macOS: System Settings > Privacy & Security > Microphone), then try again.'

export const MIC_NOT_FOUND_MESSAGE = 'No microphone was found. Connect one and try again.'

interface DesktopMicBridge {
  isDesktop?: boolean
  ensureMicAccess?: () => Promise<'granted' | 'denied' | 'restricted'>
}

export async function requestMicStream(constraints: MediaStreamConstraints = { audio: true }): Promise<MediaStream> {
  const desktop = (globalThis as { shogoDesktop?: DesktopMicBridge }).shogoDesktop
  if (desktop?.isDesktop && desktop.ensureMicAccess) {
    const access = await desktop.ensureMicAccess().catch(() => 'granted' as const)
    if (access !== 'granted') throw new Error(MIC_BLOCKED_MESSAGE)
  }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error(MIC_BLOCKED_MESSAGE)
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error(MIC_NOT_FOUND_MESSAGE)
    throw err
  }
}
