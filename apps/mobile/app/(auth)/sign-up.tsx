// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Redirect } from 'expo-router'

export default function SignUpRedirect() {
  return <Redirect href="/(auth)/sign-in" />
}
