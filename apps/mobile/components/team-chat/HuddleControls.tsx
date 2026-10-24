// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The huddle control bar: mic, camera, screen, reactions, raised hand, layout, add people, settings, leave. */
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import {
  Captions,
  CaptionsOff,
  Hand,
  LayoutGrid,
  Check,
  Link as LinkIcon,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  MonitorOff,
  NotebookPen,
  MonitorUp,
  PhoneOff,
  Presentation,
  Settings,
  Smile,
  ThumbsUp,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { WebTooltip } from '../chat/WebTooltip'
import {
  huddleVideoSupported,
  leaveHuddleCall,
  resumeHuddlePlayback,
  screenShareSupported,
  setHuddleCamera,
  setHuddleHand,
  setHuddleLayout,
  setHuddleMuted,
  setHuddleNotesEnabled,
  setHuddleScreenShare,
  type HuddleCallState,
} from '../../lib/huddle-call'
import { ReactionPicker } from './HuddleReactions'
import { cameraControl, handControl, leaveControl, micControl, reactionControl, type HuddleControlGlyph, type HuddleControlModel } from '../../lib/huddle-control-model'
import type { PipIconName } from '../../lib/huddle-pip-icons'

const CONTROL_ICONS: Record<PipIconName, typeof Mic> = {
  mic: Mic,
  micOff: MicOff,
  video: Video,
  videoOff: VideoOff,
  hand: Hand,
  smile: Smile,
  thumbsUp: ThumbsUp,
  maximize2: Maximize2,
  phoneOff: PhoneOff,
}

const GLYPH_CLASS: Record<Exclude<HuddleControlGlyph, 'white'>, string> = {
  foreground: 'text-foreground',
  destructive: 'text-destructive',
}

/** Paints a glyph the same way the floating bar does, so both bars agree. */
function glyphProps(glyph: HuddleControlGlyph) {
  return glyph === 'white' ? { color: 'white' } : { className: GLYPH_CLASS[glyph] }
}

function ControlGlyph({ control, size }: { control: HuddleControlModel; size: number }) {
  const Icon = CONTROL_ICONS[control.icon]
  return <Icon size={size} {...glyphProps(control.glyph)} />
}

export function ControlButton({
  label,
  onPress,
  active,
  disabled,
  tone = 'muted',
  size = 40,
  children,
}: {
  label: string
  onPress: () => void
  active?: boolean
  disabled?: boolean
  tone?: 'muted' | 'danger' | 'accent'
  size?: number
  children: React.ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ ...(active === undefined ? {} : { selected: active }), ...(disabled ? { disabled: true } : {}) }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className={cn(
        'items-center justify-center active:opacity-80',
        disabled ? 'opacity-40' : tone === 'danger' ? 'bg-destructive' : tone === 'accent' || active ? 'bg-emerald-600' : 'bg-muted hover:bg-muted/80',
      )}
    >
      <WebTooltip label={label}>{children}</WebTooltip>
    </Pressable>
  )
}

export interface HuddleControlsProps {
  call: HuddleCallState
  /** The mini card hides the rarely used buttons. */
  compact?: boolean
  onInvite?: () => void
  onSettings?: () => void
  onCopyLink?: () => void
  /** The link was just copied. */
  linkCopied?: boolean
  onToggleChat?: () => void
  chatOpen?: boolean
  /** How many unread chat lines, for the badge. */
  chatBadge?: number
  /** Live captions are on for this viewer. */
  captions?: boolean
  /** Hide or show the captions strip on this device (display only). */
  onToggleCaptions?: () => void
}

export function HuddleControls({ call, compact, onInvite, onSettings, onCopyLink, linkCopied, onToggleChat, chatOpen, captions, onToggleCaptions }: HuddleControlsProps) {
  const [reactions, setReactions] = useState(false)
  const size = compact ? 32 : 40
  const icon = compact ? 15 : 18
  const white = 'white'
  const mic = micControl(call.muted)
  const camera = cameraControl(call.camera)
  const reaction = reactionControl(reactions)
  const hand = handControl(call.handRaised)
  const leave = leaveControl()

  return (
    <View className="relative items-center" testID="huddle-controls">
      {reactions ? (
        <View className="absolute bottom-full z-30 mb-2">
          <ReactionPicker />
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-center gap-2">
        {call.playbackBlocked ? (
          <ControlButton label="Turn on huddle audio" size={size} tone="accent" onPress={resumeHuddlePlayback}>
            <Volume2 size={icon} color={white} />
          </ControlButton>
        ) : null}
        <ControlButton label={mic.label} size={size} tone={mic.tone} active={mic.active} onPress={() => void setHuddleMuted(!call.muted)}>
          <ControlGlyph control={mic} size={icon} />
        </ControlButton>
        {huddleVideoSupported ? (
          <ControlButton label={camera.label} size={size} tone={camera.tone} active={camera.active} onPress={() => void setHuddleCamera(!call.camera)}>
            <ControlGlyph control={camera} size={icon} />
          </ControlButton>
        ) : null}
        <ControlButton label={reaction.label} size={size} tone={reaction.tone} active={reaction.active} onPress={() => setReactions((v) => !v)}>
          <ControlGlyph control={reaction} size={icon} />
        </ControlButton>
        <ControlButton label={hand.label} size={size} tone={hand.tone} active={hand.active} onPress={() => void setHuddleHand(!call.handRaised)}>
          <ControlGlyph control={hand} size={icon} />
        </ControlButton>
        {!compact && screenShareSupported ? (
          <ControlButton label={call.screen ? 'Stop sharing' : 'Share screen'} size={size} active={call.screen} onPress={() => void setHuddleScreenShare(!call.screen)}>
            {call.screen ? <MonitorOff size={icon} color={white} /> : <MonitorUp size={icon} className="text-foreground" />}
          </ControlButton>
        ) : null}
        {!compact ? (
          <ControlButton
            label={call.layout === 'grid' ? 'Switch to speaker view' : 'Switch to grid view'}
            size={size}
            onPress={() => setHuddleLayout(call.layout === 'grid' ? 'speaker' : 'grid')}
          >
            {call.layout === 'grid' ? <Presentation size={icon} className="text-foreground" /> : <LayoutGrid size={icon} className="text-foreground" />}
          </ControlButton>
        ) : null}
        {!compact && onInvite ? (
          <ControlButton label="Add people" size={size} onPress={onInvite}>
            <UserPlus size={icon} className="text-foreground" />
          </ControlButton>
        ) : null}
        {!compact && onCopyLink ? (
          <ControlButton label={linkCopied ? 'Link copied' : 'Copy huddle link'} size={size} active={linkCopied} onPress={onCopyLink}>
            {linkCopied ? <Check size={icon} color={white} /> : <LinkIcon size={icon} className="text-foreground" />}
          </ControlButton>
        ) : null}
        {!compact && onToggleChat ? (
          <ControlButton label={chatOpen ? 'Hide huddle chat' : 'Show huddle chat'} size={size} active={chatOpen} onPress={onToggleChat}>
            <MessageSquare size={icon} color={chatOpen ? white : undefined} className={chatOpen ? undefined : 'text-foreground'} />
          </ControlButton>
        ) : null}
        {!compact ? (
          <ControlButton
            label={call.notes.enabled ? 'Turn notes off for everyone' : 'Turn notes on for everyone'}
            size={size}
            active={call.notes.enabled}
            onPress={() => void setHuddleNotesEnabled(!call.notes.enabled)}
          >
            <NotebookPen size={icon} color={call.notes.enabled ? white : undefined} className={call.notes.enabled ? undefined : 'text-foreground'} />
          </ControlButton>
        ) : null}
        {!compact && onToggleCaptions ? (
          <ControlButton
            label={
              !call.notes.enabled
                ? 'Captions need notes on'
                : captions
                  ? 'Hide captions'
                  : 'Show captions'
            }
            size={size}
            active={!!captions && call.notes.enabled}
            disabled={!call.notes.enabled}
            onPress={onToggleCaptions}
          >
            {captions && call.notes.enabled ? (
              <Captions size={icon} color={white} />
            ) : (
              <CaptionsOff size={icon} className="text-foreground" />
            )}
          </ControlButton>
        ) : null}
        {!compact && onSettings ? (
          <ControlButton label="Huddle settings" size={size} onPress={onSettings}>
            <Settings size={icon} className="text-foreground" />
          </ControlButton>
        ) : null}
        <ControlButton label={leave.label} size={size} tone={leave.tone} onPress={() => void leaveHuddleCall()}>
          <ControlGlyph control={leave} size={icon} />
        </ControlButton>
      </View>
    </View>
  )
}
