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
  /** Square tap target without alignment extras (`h-12 w-12`). */
  hitSize: string
  rowPad: string
  rowMin: string
}

export const PHONE_DENSITY: Density = {
  icon: { xs: 16, sm: 20, md: 22, lg: 24, nav: 22 },
  text: {
    caption: 'text-sm',
    label: 'text-base',
    body: 'text-lg',
    title: 'text-xl',
    heading: 'text-2xl',
  },
  hit: 'h-12 w-12 items-center justify-center',
  hitSize: 'h-12 w-12',
  rowPad: 'px-4 py-4',
  rowMin: 'min-h-12',
}

/** Account settings sheet chrome — one step above phone rows. */
export const ACCOUNT_SHEET_DENSITY: Density = {
  icon: { xs: 18, sm: 22, md: 24, lg: 28, nav: 24 },
  text: {
    caption: 'text-base',
    label: 'text-lg',
    body: 'text-xl',
    title: 'text-2xl',
    heading: 'text-3xl',
  },
  hit: 'h-12 w-12 items-center justify-center',
  hitSize: 'h-12 w-12',
  rowPad: 'px-4 py-4',
  rowMin: 'min-h-12',
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
  hitSize: '',
  rowPad: 'px-4 py-3',
  rowMin: '',
}

export const densityFor = (comfortable: boolean): Density =>
  comfortable ? PHONE_DENSITY : COMPACT_DENSITY

export function usePhoneDensity(): Density {
  return densityFor(useIsNativePhoneLayout())
}
