// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal port broker — allocates the data-plane MessageChannelMain
 * for an attach request and hands ports to both ends.
 *
 *   Renderer.attach(id, since) ─▶ ipcRenderer.invoke('terminal:attach',…)
 *       │
 *       ▼
 *   main: brokerAttach(webContents, id, since)
 *       │  const { port1, port2 } = new MessageChannelMain()
 *       │  ptyHost.attachWithPort(id, since, port1)
 *       │     └─▶ utilityProcess.postMessage(<attach req>, [port1])
 *       │  webContents.postMessage(PTY_PORT_CHANNEL,
 *       │     { sessionId, channelId, latestSeq }, [port2])
 *       │
 *       ▼
 *   Renderer.preload: ipcRenderer.on(PTY_PORT_CHANNEL) → resolves the
 *   pending attach() Promise with { port2, channelId, latestSeq }.
 *
 * The renderer-side port arrives via `ipcRenderer.on(channel)` callback's
 * `event.ports[0]` — that's the canonical way to receive a transferred
 * MessagePort in an Electron renderer.
 */

import { MessageChannelMain, type WebContents } from 'electron'
import { getPtyHostClient } from '../pty-host-client'
import { PTY_PORT_CHANNEL } from '../pty-host/protocol'

/**
 * Returns the channelId + latestSeq the renderer needs. The
 * MessagePort itself is delivered to the renderer via webContents.postMessage
 * — the caller does NOT receive it here.
 */
export async function brokerAttach(
  wc: WebContents,
  sessionId: string,
  sinceSeq: number,
): Promise<{ channelId: string; latestSeq: number }> {
  const { port1, port2 } = new MessageChannelMain()
  const host = getPtyHostClient()

  let attachResult: { channelId: string; latestSeq: number }
  try {
    attachResult = await host.attachWithPort(sessionId, sinceSeq, port1)
  } catch (err) {
    // attachWithPort failed — close ports we no longer own. port1 was
    // postMessage'd to the utility but the host couldn't subscribe; the
    // host should garbage-collect it. port2 stays here — close it.
    try { port2.close() } catch { /* swallow */ }
    throw err
  }

  // Deliver port2 to the renderer.
  wc.postMessage(
    PTY_PORT_CHANNEL,
    {
      sessionId,
      channelId: attachResult.channelId,
      latestSeq: attachResult.latestSeq,
    },
    [port2],
  )

  return attachResult
}

export { PTY_PORT_CHANNEL }
