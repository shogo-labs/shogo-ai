// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tells the server this iPhone's Live Activity tokens, so it can start and
 * update the activity while the app is closed. The tokens arrive from iOS at
 * unpredictable times, and the server needs the device's Expo push token to
 * file them under, so this sends whatever changed once both are known.
 */
export interface LiveActivityTokenFields {
  activityToken?: string | null
  pushToStartToken?: string | null
}

type TokenKey = 'activityToken' | 'pushToStartToken'

export type PutLiveActivityTokens = (body: { pushToken: string } & LiveActivityTokenFields) => Promise<unknown>

export function createLiveActivityTokenSync(put: PutLiveActivityTokens) {
  let pushToken: string | null = null
  /** What the server has been told, per field. */
  const sent: Record<TokenKey, string | null | undefined> = { activityToken: undefined, pushToStartToken: undefined }
  /** What iOS last said, per field. */
  const wanted: Record<TokenKey, string | null | undefined> = { activityToken: undefined, pushToStartToken: undefined }
  let flushing: Promise<void> = Promise.resolve()

  function flush(): Promise<void> {
    flushing = flushing.then(async () => {
      if (!pushToken) return
      const body: { pushToken: string } & LiveActivityTokenFields = { pushToken }
      let dirty = false
      for (const key of ['activityToken', 'pushToStartToken'] as const) {
        if (wanted[key] !== undefined && wanted[key] !== sent[key]) {
          body[key] = wanted[key]
          dirty = true
        }
      }
      if (!dirty) return
      try {
        await put(body)
        for (const key of ['activityToken', 'pushToStartToken'] as const) if (key in body) sent[key] = body[key]
      } catch {
        // Retried the next time a token or the device changes.
      }
    })
    return flushing
  }

  return {
    /** The device's Expo push token once it is registered; null on sign-out. */
    setPushToken(token: string | null): Promise<void> {
      if (token !== pushToken) {
        pushToken = token
        // A different device row (or none): the server knows nothing about these yet.
        sent.activityToken = undefined
        sent.pushToStartToken = undefined
      }
      return flush()
    },
    setActivityToken(token: string | null): Promise<void> {
      wanted.activityToken = token
      return flush()
    },
    setPushToStartToken(token: string | null): Promise<void> {
      wanted.pushToStartToken = token
      return flush()
    },
  }
}
