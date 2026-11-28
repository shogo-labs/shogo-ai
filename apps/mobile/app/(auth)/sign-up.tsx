// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Redirect, useLocalSearchParams } from 'expo-router'

/**
 * `/sign-up` has always been the Sign In page. Forward every query param with
 * it: a marketing link arrives as
 * `/sign-up?mode=signup&prompt=…&intent=hero_prompt`, and a bare redirect to
 * `/sign-in` rebuilt the href without the query, dropping the intent from the
 * address bar. The capture in the root layout has already stored it by the
 * time this renders; keeping the params keeps the URL honest for analytics
 * and for anything that reads it after sign-up.
 */
export default function SignUpRedirect() {
  const params = useLocalSearchParams()
  return <Redirect href={{ pathname: '/(auth)/sign-in', params } as never} />
}
