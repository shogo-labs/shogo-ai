// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The huddle control bar: mic, camera, screen, reactions, raised hand, layout, add people, settings, leave. */
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import {
  Hand,
  LayoutGrid,
  Check,
  Link as LinkIcon,
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

export function ControlButton({
  label,
  onPress,
  active,
  tone = 'muted',
  size = 40,
  children,
}: {
  label: string
  onPress: () => void
  active?: boolean
  tone?: 'muted' | 'danger' | 'accent'
  size?: number
  children: React.ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className={cn(
        'items-center justify-center active:opacity-80',
        tone === 'danger' ? 'bg-destructive' : tone === 'accent' || active ? 'bg-emerald-600' : 'bg-muted hover:bg-muted/80',
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
}

export function HuddleControls({ call, compact, onInvite, onSettings, onCopyLink, linkCopied, onToggleChat, chatOpen }: HuddleControlsProps) {
  const [reactions, setReactions] = useState(false)
  const size = compact ? 32 : 40
  const icon = compact ? 15 : 18
  const white = 'white'

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
        <ControlButton label={call.muted ? 'Unmute' : 'Mute'} size={size} onPress={() => void setHuddleMuted(!call.muted)}>
          {call.muted ? <MicOff size={icon} className="text-destructive" /> : <Mic size={icon} className="text-foreground" />}
        </ControlButton>
        {huddleVideoSupported ? (
          <ControlButton label={call.camera ? 'Turn off camera' : 'Turn on camera'} size={size} active={call.camera} onPress={() => void setHuddleCamera(!call.camera)}>
            {call.camera ? <Video size={icon} color={white} /> : <VideoOff size={icon} className="text-foreground" />}
          </ControlButton>
        ) : null}
        <ControlButton label="Send a reaction" size={size} active={reactions} onPress={() => setReactions((v) => !v)}>
          <Smile size={icon} color={reactions ? white : undefined} className={reactions ? undefined : 'text-foreground'} />
        </ControlButton>
        <ControlButton label={call.handRaised ? 'Lower hand' : 'Raise hand'} size={size} active={call.handRaised} onPress={() => void setHuddleHand(!call.handRaised)}>
          <Hand size={icon} color={call.handRaised ? white : undefined} className={call.handRaised ? undefined : 'text-foreground'} />
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
        {!compact && onSettings ? (
          <ControlButton label="Huddle settings" size={size} onPress={onSettings}>
            <Settings size={icon} className="text-foreground" />
          </ControlButton>
        ) : null}
        <ControlButton label="Leave huddle" size={size} tone="danger" onPress={() => void leaveHuddleCall()}>
          <PhoneOff size={icon} color={white} />
        </ControlButton>
      </View>
    </View>
  )
}
