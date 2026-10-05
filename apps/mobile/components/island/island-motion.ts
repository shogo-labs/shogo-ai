// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { MotionTransition } from "@legendapp/motion"

/** Camera housing width; notched layouts reserve it between the wings. */
export const NOTCH_WIDTH = 200
/** Idle wing width at rest and while hovered. */
export const IDLE_WING = 22
export const IDLE_WING_HOVER = 36
export const IDLE_NOTCHED_WIDTH = NOTCH_WIDTH + IDLE_WING * 2
/** Virtual-notch tab dimensions; the desktop hidden window must fit the hover width. */
export const IDLE_TAB_WIDTH = 96
export const IDLE_TAB_HOVER_WIDTH = 140
export const IDLE_TAB_HEIGHT = 28
/** Collapsed left wing (status icon only); the right wing takes the rest.
 * Must match `NOTCHED_COLLAPSED_LEFT_WING` in desktop `island-placement.ts`. */
export const COLLAPSED_LEFT_WING = 40

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4
const easeInCubic = (t: number) => t ** 3

/** Opening decelerates out of the notch; closing accelerates back into it,
 * shorter so dismissing never feels sluggish. No overshoot anywhere: a
 * bouncing surface fighting the hardware notch reads as jitter. */
export const ISLAND_OPEN: MotionTransition = {
  type: "tween",
  duration: 360,
  easing: easeOutQuart,
}
export const ISLAND_CLOSE: MotionTransition = {
  type: "tween",
  duration: 190,
  easing: easeInCubic,
}
export const ISLAND_HOVER: MotionTransition = {
  type: "tween",
  duration: 240,
  easing: easeOutQuart,
}
export const ISLAND_CONTENT_IN: MotionTransition = {
  type: "tween",
  duration: 220,
  delay: 90,
  easing: easeOutQuart,
}
export const ISLAND_CONTENT_OUT: MotionTransition = {
  type: "tween",
  duration: 90,
  easing: easeInCubic,
}
/** How long the renderer plays the close before the window shrinks. */
export const ISLAND_CLOSE_MS = 190

const INSTANT: MotionTransition = { type: "tween", duration: 0 }

export function islandMotion(reducedMotion: boolean, transition: MotionTransition): MotionTransition {
  return reducedMotion ? INSTANT : transition
}
