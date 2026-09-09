// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useIsNativePhoneLayout } from './native-phone-layout'

export type Density = {
  icon: { xs: number; sm: number; md: number; lg: number; nav: number }
  text: {
    caption: string
    label: string
    body: string
    title: string
    heading: string
  }
  hit: string
  rowPad: string
  rowMin: string
}

export const PHONE_DENSITY: Density = {
  icon: { xs: 14, sm: 16, md: 18, lg: 20, nav: 18 },
  text: {
    caption: 'text-xs',
    label: 'text-sm',
    body: 'text-base',
    title: 'text-lg',
    heading: 'text-xl',
  },
  hit: 'h-11 w-11 items-center justify-center',
  rowPad: 'px-4 py-3.5',
  rowMin: 'min-h-11',
}

export const COMPACT_DENSITY: Density = {
  icon: { xs: 10, sm: 12, md: 14, lg: 16, nav: 12 },
  text: {
    caption: 'text-[10px]',
    label: 'text-xs',
    body: 'text-sm',
    title: 'text-sm',
    heading: 'text-lg',
  },
  hit: 'p-1',
  rowPad: 'px-4 py-3',
  rowMin: '',
}

export const densityFor = (comfortable: boolean): Density =>
  comfortable ? PHONE_DENSITY : COMPACT_DENSITY

export function usePhoneDensity(): Density {
  return densityFor(useIsNativePhoneLayout())
}
