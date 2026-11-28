// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Redirect, useLocalSearchParams } from 'expo-router'

/**
 * `/sign-up` is the URL a marketing link, an ad or a QR code points at. It
 * shares the one auth screen with `/sign-in` (one form pair, one route), so the
 * only thing this screen does is forward the visitor there **on the Sign Up
 * tab** with everything the link carried (SHO-613).
 *
 * The old `<Redirect href="/(auth)/sign-in" />` dropped the whole query string,
 * which is how `?utm_source=ig&plan=pro&prompt=…` — and the tab itself — never
 * reached the form.
 */
export default function SignUpRedirect() {
  const params = useLocalSearchParams()
  return (
    <Redirect
      href={{
        pathname: '/(auth)/sign-in',
        params: { ...params, mode: 'signup' },
      }}
    />
  )
}
