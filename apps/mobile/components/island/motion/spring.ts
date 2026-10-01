// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Spring and curve maths adapted from coucou (MIT, Copyright (c) 2026 Louis Raillé),
// https://github.com/Louis-CFM/coucou/blob/main/windows/src/core/anim.ts

export type EaseFn = (t: number) => number

export const Ease = {
  out: (t: number) => 1 - (1 - t) ** 3,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2,
  lin: (t: number) => t,
  in: (t: number) => t * t * t,
} satisfies Record<string, EaseFn>

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
  const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    let t = x
    for (let i = 0; i < 16; i++) {
      if (bx(t) < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return by(t)
  }
}

/** Shrinking motion: quick to start, no overshoot. */
export const closeCurve = cubicBezier(0.45, 0, 0.2, 1)

export const OPEN_SPRING = { response: 0.5, damping: 0.72 } as const
export const CLOSE_MS = 340

/** SwiftUI-style spring: ω₀ = 2π / response, ζ = damping. Sub-stepped so a
 * dropped frame can't destabilise it. */
export class Spring {
  value: number
  target: number
  velocity = 0
  private omega: number
  private zeta: number

  constructor(value: number, response: number = OPEN_SPRING.response, damping: number = OPEN_SPRING.damping) {
    this.value = value
    this.target = value
    this.omega = (2 * Math.PI) / response
    this.zeta = damping
  }

  configure(response: number, damping: number) {
    this.omega = (2 * Math.PI) / response
    this.zeta = damping
  }

  set(value: number) {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  get settled(): boolean {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05
  }

  step(dt: number) {
    const steps = Math.max(1, Math.ceil(dt * 240))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      const acc = this.omega ** 2 * (this.target - this.value) - 2 * this.zeta * this.omega * this.velocity
      this.velocity += acc * h
      this.value += this.velocity * h
    }
    if (this.settled) {
      this.value = this.target
      this.velocity = 0
    }
  }
}

/** A value that springs when growing and follows `closeCurve` when shrinking. */
export class Tracked {
  private spring: Spring
  private from = 0
  private to = 0
  private start = 0
  private duration = 0
  private mode: "spring" | "curve" | "idle" = "idle"

  constructor(value: number) {
    this.spring = new Spring(value)
  }

  get value(): number {
    return this.spring.value
  }

  get target(): number {
    return this.spring.target
  }

  get animating(): boolean {
    return this.mode !== "idle"
  }

  jump(value: number) {
    this.spring.set(value)
    this.mode = "idle"
  }

  springTo(value: number, response: number = OPEN_SPRING.response, damping: number = OPEN_SPRING.damping) {
    this.spring.configure(response, damping)
    this.spring.target = value
    this.mode = "spring"
  }

  curveTo(value: number, durationMs = CLOSE_MS, nowMs = performance.now()) {
    this.from = this.spring.value
    this.to = value
    this.start = nowMs
    this.duration = durationMs
    this.spring.target = value
    this.spring.velocity = 0
    this.mode = "curve"
  }

  /** Springs up, curves down. */
  animateTo(value: number, nowMs = performance.now()) {
    if (value === this.spring.target && this.mode !== "idle") return
    if (value < this.spring.value) this.curveTo(value, CLOSE_MS, nowMs)
    else this.springTo(value)
  }

  step(dt: number, nowMs = performance.now()) {
    if (this.mode === "spring") {
      this.spring.step(dt)
      if (this.spring.settled) this.mode = "idle"
    } else if (this.mode === "curve") {
      const p = clamp((nowMs - this.start) / this.duration, 0, 1)
      this.spring.value = lerp(this.from, this.to, closeCurve(p))
      if (p >= 1) this.mode = "idle"
    }
  }
}
