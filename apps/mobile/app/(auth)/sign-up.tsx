// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Redirect } from 'expo-router'

export default function SignUpRedirect() {
  return <Redirect href="/(auth)/sign-in" />
}
