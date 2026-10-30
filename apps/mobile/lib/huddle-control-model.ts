// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One definition of what each huddle control *means*, shared by the in-huddle
 * bar (`HuddleControls`) and the floating picture-in-picture bar (`HuddlePip`).
 *
 * The two bars render differently — one is React Native with Tailwind classes,
 * the other plain DOM with inline styles in a stylesheet-free window — but a
 * control's label, its active state and above all its colour must not depend on
 * which surface you happen to be looking at. They used to: the PiP bar painted
 * a muted mic red and a raised hand amber, while the in-huddle bar kept the
 * circle neutral with a red glyph and used the same accent for every active
 * control. Keeping the mapping here is what stops that drift coming back.
 */
import type { PipIconName } from './huddle-pip-icons'

/** Fill of the control's circle. */
export type HuddleControlTone = 'muted' | 'accent' | 'danger'

/** Colour of the glyph inside the circle. */
export type HuddleControlGlyph = 'foreground' | 'white' | 'destructive'

export interface HuddleControlModel {
  label: string
  tone: HuddleControlTone
  /** Only where a control has a real on/off state the reader should hear. */
  active?: boolean
  icon: PipIconName
  glyph: HuddleControlGlyph
}

export function micControl(muted: boolean): HuddleControlModel {
  return {
    label: muted ? 'Unmute' : 'Mute',
    tone: 'muted',
    icon: muted ? 'micOff' : 'mic',
    glyph: muted ? 'destructive' : 'foreground',
  }
}

export function cameraControl(on: boolean): HuddleControlModel {
  return {
    label: on ? 'Turn off camera' : 'Turn on camera',
    tone: on ? 'accent' : 'muted',
    active: on,
    icon: on ? 'video' : 'videoOff',
    glyph: on ? 'white' : 'foreground',
  }
}

/** Opens the reaction picker. Used by the in-huddle bar, which has room for it. */
export function reactionControl(open: boolean): HuddleControlModel {
  return {
    label: 'Send a reaction',
    tone: open ? 'accent' : 'muted',
    active: open,
    icon: 'smile',
    glyph: open ? 'white' : 'foreground',
  }
}

/**
 * Sends a single thumbs-up with no picker. The floating window is too small to
 * hold the picker, so it reacts in one tap — the same glyph language, a
 * smaller affordance.
 */
export function quickReactionControl(): HuddleControlModel {
  return {
    label: 'React 👍',
    tone: 'muted',
    icon: 'thumbsUp',
    glyph: 'foreground',
  }
}

export function handControl(raised: boolean): HuddleControlModel {
  return {
    label: raised ? 'Lower hand' : 'Raise hand',
    tone: raised ? 'accent' : 'muted',
    active: raised,
    icon: 'hand',
    glyph: raised ? 'white' : 'foreground',
  }
}

export function leaveControl(): HuddleControlModel {
  return { label: 'Leave huddle', tone: 'danger', icon: 'phoneOff', glyph: 'white' }
}
