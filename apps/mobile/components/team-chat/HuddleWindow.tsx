// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The call surface, separate from the chat and mounted once in the app layout.
 * Three views of the same call:
 *
 * - **Expanded**: a large panel with the stage (grid or speaker layout), a
 *   rail of people, and the full control bar.
 * - **Mini**: a small floating card you can drag to any corner. It stays over
 *   every screen, including the call's own conversation, so you can read chat
 *   and still see who is talking and what they react with.
 * - **Pill**: a one-line chip with faces and a speaking indicator.
 *
 * The choice is remembered on this device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Animated, PanResponder, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronsDown, Expand, Headphones, Shrink, MessageSquare, Maximize2, Minimize2, MicOff, PhoneOff, Mic, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useHuddleRoster } from '../../hooks/useHuddleRoster'
import {
  clearHuddleNotice,
  getHuddleShareLink,
  isHuddleHostedElsewhere,
  leaveHuddleCall,
  muteHuddleParticipant,
  pinHuddleParticipant,
  removeHuddleParticipant,
  setHuddleMuted,
  setHuddleView,
  useHuddleCall,
} from '../../lib/huddle-call'
import { getHuddleHostBridge } from '../../lib/desktop-huddle'
import { setHuddlePrefs, useHuddlePrefs, type MiniCorner } from '../../lib/huddle-prefs'
import { SPRING, projectMomentum, DECELERATION } from '../../lib/motion'
import { miniFeature, miniScreen, miniSelfView, summarizeNames, type RosterEntry } from '../../lib/huddle-roster'
import { captionsNotice } from '../../lib/huddle-captions'
import { HuddleCaptions } from './HuddleCaptions'
import { HuddleControls } from './HuddleControls'
import { HuddleInviteSheet } from './HuddleInviteSheet'
import { HuddleRequests, HuddleRequestStrip } from './HuddleRequests'
import { HuddleThreadPanel } from './HuddleThreadPanel'
import { useHuddleChat } from '../../hooks/useHuddleChat'
import { HuddleNotesPill } from './HuddleNotesPill'
import { HuddlePrejoin } from './HuddlePrejoin'
import { ReactionOverlay } from './HuddleReactions'
import { HuddleSettingsSheet } from './HuddleSettingsSheet'
import { HuddleStageView, PersonTile, type TileActions } from './HuddleStageView'
import { HuddleVideo } from './HuddleVideo'
import { closePictureInPicture, HuddlePip, useAutoPictureInPicture, usePictureInPicture } from './HuddlePip'
import { UserAvatar } from './UserAvatar'

export const MINI_WIDTH = 320
export const MINI_HEIGHT = 200
const MARGIN = 12

/** Where the card sits for each corner, as top/left in pixels. */
export function cornerOrigin(corner: MiniCorner, win: { width: number; height: number }, insets: { top: number; bottom: number }, size = { width: MINI_WIDTH, height: MINI_HEIGHT }) {
  const w = Math.min(size.width, win.width - MARGIN * 2)
  const left = corner.endsWith('left') ? MARGIN : win.width - MARGIN - w
  const top = corner.startsWith('top') ? MARGIN + insets.top : win.height - MARGIN - size.height - insets.bottom
  return { left, top, width: w }
}

/** The corner nearest to where the card was let go. */
export function nearestCorner(center: { x: number; y: number }, win: { width: number; height: number }): MiniCorner {
  const horizontal = center.x < win.width / 2 ? 'left' : 'right'
  const vertical = center.y < win.height / 2 ? 'top' : 'bottom'
  return `${vertical}-${horizontal}` as MiniCorner
}

function Faces({ roster, max = 5, size = 24 }: { roster: RosterEntry[]; max?: number; size?: number }) {
  const people = roster.filter((e) => e.status === 'in-call').slice(0, max)
  return (
    <View className="flex-row" testID="huddle-faces">
      {people.map((p, i) => (
        <View
          key={p.userId}
          style={i ? { marginLeft: -8 } : undefined}
          className={cn('rounded-full border-2', p.speaking ? 'border-emerald-500' : 'border-card')}
          accessibilityLabel={[p.isLocal ? 'You' : p.name, p.speaking ? 'speaking' : null, p.muted ? 'muted' : null].filter(Boolean).join(', ')}
        >
          <UserAvatar name={p.name} image={p.image} size={size} />
          {p.muted ? (
            <View className="absolute -bottom-0.5 -right-0.5 rounded-full bg-card p-0.5">
              <MicOff size={8} color="#f87171" />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  )
}

/** The mini card's content: the featured person, a strip of faces, and the short control row. */
export function HuddleMiniCard({ onExpand, onPill }: { onExpand: () => void; onPill?: () => void }) {
  const { call, roster, huddle } = useHuddleRoster()
  const feature = useMemo(() => miniFeature(roster, call.speaking, call.pinned), [roster, call.speaking, call.pinned])
  const screen = useMemo(() => miniScreen(roster), [roster])
  const selfView = useMemo(() => miniSelfView(roster, feature), [roster, feature])
  const inCall = roster.filter((e) => e.status === 'in-call')
  const ringing = roster.filter((e) => e.status === 'ringing')
  const status =
    call.status === 'joining' ? 'Joining…' : call.status === 'reconnecting' ? 'Reconnecting…' : !feature || (inCall.length === 1 && ringing.length) ? 'Ringing…' : null

  return (
    <View className="flex-1 overflow-hidden rounded-2xl border border-emerald-500/40 bg-card shadow-2xl" testID="huddle-mini">
      <View className="min-h-0 flex-1 bg-zinc-900">
        {screen ? (
          <View className="flex-1 bg-black" testID="huddle-mini-screen">
            <HuddleVideo tile={screen} fit="contain" />
          </View>
        ) : feature ? (
          <PersonTile entry={feature} className="flex-1 rounded-none border-0" avatarSize={56} showMenu={false} />
        ) : null}
        {selfView ? (
          <View className="absolute bottom-1.5 right-1.5 h-16 w-28 overflow-hidden rounded-lg border border-white/30 bg-black" testID="huddle-mini-self">
            <HuddleVideo tile={selfView} fit="cover" />
          </View>
        ) : null}
        {status ? (
          <View className="absolute inset-0 items-center justify-center">
            <Text className="text-sm text-zinc-300">{status}</Text>
          </View>
        ) : null}
        <ReactionOverlay reactions={call.reactions} size={22} />
        <HuddleRequestStrip requests={huddle?.requests} />
        <View className="absolute right-1.5 top-1.5 flex-row gap-1">
          {onPill ? (
            <Pressable onPress={onPill} accessibilityRole="button" accessibilityLabel="Collapse to pill" className="rounded-full bg-black/60 p-1.5 active:opacity-70">
              <ChevronsDown size={13} color="white" />
            </Pressable>
          ) : null}
          <Pressable onPress={onExpand} accessibilityRole="button" accessibilityLabel="Expand huddle" className="rounded-full bg-black/60 p-1.5 active:opacity-70">
            <Maximize2 size={13} color="white" />
          </Pressable>
        </View>
        <View className="absolute left-1.5 top-1.5 flex-row items-center gap-1">
          <Faces roster={roster} size={20} />
          <HuddleNotesPill notes={call.notes} compact />
        </View>
      </View>
      <View className="items-center px-2 py-1.5">
        <HuddleControls call={call} compact />
      </View>
    </View>
  )
}

/** One-line chip: faces, who is speaking, mute and leave. */
export function HuddlePill({ onExpand }: { onExpand: () => void }) {
  const { call, roster, huddle } = useHuddleRoster()
  const waiting = huddle?.requests?.length ?? 0
  const speaker = roster.find((e) => e.speaking && !e.isLocal)
  const label =
    call.status === 'joining' ? 'Joining…' : call.status === 'reconnecting' ? 'Reconnecting…' : speaker ? `${speaker.name} is speaking` : call.label ?? 'Huddle'
  return (
    <View className="flex-row items-center gap-2 rounded-full border border-emerald-500/40 bg-card px-2 py-1.5 shadow-lg" testID="huddle-pill">
      <Pressable onPress={onExpand} accessibilityRole="button" accessibilityLabel={`Open huddle in ${call.label ?? 'conversation'}`} className="max-w-[220px] flex-row items-center gap-2 pl-1">
        <Headphones size={16} className="text-emerald-600" />
        <Faces roster={roster} max={3} size={22} />
        <Text className="flex-shrink text-sm font-medium text-foreground" numberOfLines={1}>
          {label}
        </Text>
        {call.notes.enabled ? null : (
          <View className="rounded-full bg-muted px-1.5 py-0.5" accessibilityLabel="Notes are off" testID="huddle-pill-notes">
            <Text className="text-[10px] font-semibold text-muted-foreground">Notes off</Text>
          </View>
        )}
        {waiting ? (
          <View className="rounded-full bg-amber-400 px-1.5 py-0.5" accessibilityLabel={`${waiting} waiting to join`} testID="huddle-pill-requests">
            <Text className="text-[10px] font-bold text-black">{waiting}</Text>
          </View>
        ) : null}
      </Pressable>
      <Pressable
        onPress={() => void setHuddleMuted(!call.muted)}
        accessibilityRole="button"
        accessibilityLabel={call.muted ? 'Unmute' : 'Mute'}
        className="h-8 w-8 items-center justify-center rounded-full bg-muted active:opacity-80"
      >
        {call.muted ? <MicOff size={15} className="text-destructive" /> : <Mic size={15} className="text-foreground" />}
      </Pressable>
      <Pressable onPress={() => void leaveHuddleCall()} accessibilityRole="button" accessibilityLabel="Leave huddle" className="h-8 w-8 items-center justify-center rounded-full bg-destructive active:opacity-80">
        <PhoneOff size={15} color="white" />
      </Pressable>
    </View>
  )
}

/** The large view: header, stage, and the full control bar. */
/** Fullscreen for one element (web and desktop). Tracks the browser's own state so Esc keeps the button honest. */
function useFullscreen(ref: React.RefObject<View | null>) {
  const [active, setActive] = useState(false)
  const supported = Platform.OS === 'web' && typeof document !== 'undefined' && !!document.documentElement?.requestFullscreen
  useEffect(() => {
    if (!supported) return
    const sync = () => setActive(!!document.fullscreenElement && document.fullscreenElement === (ref.current as unknown as Element | null))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [supported, ref])
  const toggle = useCallback(() => {
    if (!supported) return
    const el = ref.current as unknown as HTMLElement | null
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void el?.requestFullscreen?.().catch(() => {})
  }, [supported, ref])
  return { supported, active, toggle }
}

export function HuddlePanel() {
  const { call, roster, huddle, canModerate } = useHuddleRoster()
  // An outside guest is in the call and nothing else: no conversation, chat, invites or link.
  const guest = !!call.guest
  const host = getHuddleHostBridge()
  const panel = useRef<View>(null)
  const fullscreen = useFullscreen(panel)
  const router = useRouter()
  const [invite, setInvite] = useState(false)
  const [settings, setSettings] = useState(false)
  const [chat, setChat] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  // Two people chat in their DM; adding people moves the chat to the group of exactly those in the call.
  const huddleChat = useHuddleChat(guest ? null : call.conversationId, huddle)
  const chatTarget =
    huddleChat.target ??
    (huddleChat.failed && huddle?.messageId && call.conversationId ? { conversationId: call.conversationId, threadRootId: huddle.messageId } : null)
  const chatConversationId = chatTarget?.conversationId ?? call.conversationId!
  const pip = usePictureInPicture()
  const win = useWindowDimensions()
  const prefs = useHuddlePrefs()
  const sideBySide = win.width >= 760
  const copyLink = useCallback(async () => {
    const link = await getHuddleShareLink()
    if (!link) return
    await Clipboard.setStringAsync(link).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2000)
  }, [])

  const actions: TileActions = useMemo(
    () => ({ pinned: call.pinned, onPin: pinHuddleParticipant, canModerate, onMute: (id) => void muteHuddleParticipant(id), onRemove: (id) => void removeHuddleParticipant(id) }),
    [call.pinned, canModerate],
  )
  // Caption labels come from the call's own roster, never from the stream's text.
  const captionNameOf = useCallback(
    (speakerId: string) =>
      call.participants.find((p) => p.userId === speakerId)?.name ?? roster.find((e) => e.userId === speakerId)?.name,
    [call.participants, roster],
  )
  const inCallNames = roster.filter((e) => e.status === 'in-call' && !e.isLocal).map((e) => e.name)
  const ringing = roster.filter((e) => e.status === 'ringing').length
  const subtitle =
    call.status === 'joining'
      ? 'Joining…'
      : call.status === 'reconnecting'
        ? 'Reconnecting…'
        : inCallNames.length
          ? `With ${summarizeNames(inCallNames)}${ringing ? ` · ringing ${ringing}` : ''}`
          : ringing
            ? `Ringing ${ringing}…`
            : 'Waiting for others'

  return (
    <View ref={panel} className="flex-1 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl" testID="huddle-expanded">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <Headphones size={16} className="text-emerald-600" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{call.label ?? 'Huddle'}</Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>{subtitle}</Text>
        </View>
        <HuddleNotesPill notes={call.notes} />
        {guest ? null : (
          <HeaderButton
            label="Open conversation"
            onPress={() =>
              host
                ? host.showApp(`/c/${chatConversationId}`)
                : router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: chatConversationId } } as any)
            }
          >
            <MessageSquare size={15} className="text-foreground" />
          </HeaderButton>
        )}
        {fullscreen.supported ? (
          <HeaderButton label={fullscreen.active ? 'Exit full screen' : 'Full screen'} onPress={fullscreen.toggle}>
            {fullscreen.active ? <Shrink size={15} className="text-foreground" /> : <Expand size={15} className="text-foreground" />}
          </HeaderButton>
        ) : null}
        {pip.supported && !host ? (
          <HeaderButton label="Pop out" onPress={() => void pip.open()}>
            <Maximize2 size={15} className="text-foreground" />
          </HeaderButton>
        ) : null}
        {guest ? null : (
          <HeaderButton label="Minimize to a floating card" onPress={() => setHuddleView('mini')}>
            <Minimize2 size={15} className="text-foreground" />
          </HeaderButton>
        )}
        {host || guest ? null : (
          <HeaderButton label="Collapse to pill" onPress={() => setHuddleView('pill')}>
            <ChevronsDown size={15} className="text-foreground" />
          </HeaderButton>
        )}
      </View>

      <HuddleRequests requests={huddle?.requests} />

      <View className={cn('min-h-0 flex-1', sideBySide && chat && 'flex-row')}>
        <View className="min-h-0 flex-1 p-3">
          <HuddleStageView roster={roster} layout={call.layout} pinned={call.pinned} speaking={call.speaking} reactions={call.reactions} actions={actions} />
        </View>
        {chat && call.workspaceId && call.conversationId ? (
          <View className={cn(sideBySide ? 'w-80 border-l border-border' : 'absolute inset-0 bg-background')} testID="huddle-chat-pane">
            <HuddleThreadPanel
              workspaceId={call.workspaceId}
              huddleConversationId={call.conversationId}
              chat={chatTarget}
              canModerate={canModerate}
              onClose={() => setChat(false)}
            />
          </View>
        ) : null}
      </View>

      {call.notice ? (
        <Pressable onPress={clearHuddleNotice} accessibilityRole="button" accessibilityLabel={`${call.notice}. Dismiss`} className="mx-3 mb-2 flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
          <Text className="flex-1 text-xs text-destructive">{call.notice}</Text>
          <X size={14} className="text-destructive" />
        </Pressable>
      ) : null}

      <View className="border-t border-border px-3 py-3">
        {prefs.captions ? (
          <HuddleCaptions
            lines={call.captions}
            nameOf={captionNameOf}
            notesOff={!call.notes.enabled}
            notice={captionsNotice(call.wake)}
          />
        ) : null}
        <HuddleControls
          call={call}
          onInvite={guest ? undefined : () => setInvite(true)}
          onSettings={() => setSettings(true)}
          onCopyLink={guest ? undefined : () => void copyLink()}
          linkCopied={linkCopied}
          onToggleChat={guest ? undefined : () => setChat((v) => !v)}
          chatOpen={chat}
          captions={prefs.captions}
          onToggleCaptions={() => setHuddlePrefs({ captions: !prefs.captions })}
        />
      </View>

      {invite && call.workspaceId ? <HuddleInviteSheet workspaceId={call.workspaceId} huddle={huddle} onClose={() => setInvite(false)} /> : null}
      {settings ? <HuddleSettingsSheet inCall conversationId={call.conversationId} onClose={() => setSettings(false)} /> : null}
    </View>
  )
}

function HeaderButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} className="h-8 w-8 items-center justify-center rounded-md active:bg-muted hover:bg-muted">
      {children}
    </Pressable>
  )
}

/** Drag the card anywhere; on release it glides to the nearest corner and remembers it. */
function useCornerDrag(corner: MiniCorner, anchor: (c: MiniCorner) => { left: number; top: number }, size: { width: number; height: number }, win: { width: number; height: number }) {
  const pan = useRef(new Animated.ValueXY()).current
  const latest = useRef({ corner, anchor, size, win })
  latest.current = { corner, anchor, size, win }

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
        onPanResponderGrant: () => {
          pan.setOffset({ x: (pan.x as any)._value, y: (pan.y as any)._value })
          pan.setValue({ x: 0, y: 0 })
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
        onPanResponderRelease: (_, g) => {
          pan.flattenOffset()
          const { corner: from, anchor: at, size: s, win: w } = latest.current
          const origin = at(from)
          const x = (pan.x as any)._value as number
          const y = (pan.y as any)._value as number
          // Land on the corner the window would coast to, not just the one it is
          // nearest at release, and carry the throw's velocity into the spring.
          const coastX = projectMomentum(g.vx * 1000, DECELERATION.fast)
          const coastY = projectMomentum(g.vy * 1000, DECELERATION.fast)
          const target = nearestCorner(
            { x: origin.left + x + coastX + s.width / 2, y: origin.top + y + coastY + s.height / 2 },
            w,
          )
          const to = at(target)
          Animated.spring(pan, {
            toValue: { x: to.left - origin.left, y: to.top - origin.top },
            velocity: { x: g.vx * 1000, y: g.vy * 1000 },
            ...SPRING.snappy,
            useNativeDriver: false,
          }).start(() => {
            setHuddlePrefs({ miniCorner: target })
            pan.setValue({ x: 0, y: 0 })
          })
        },
      }),
    [pan],
  )
  return { pan, handlers: responder.panHandlers }
}

/**
 * The call surface. Mount once in the app layout; it renders nothing outside a call
 * (besides the pre-join preview) and floats over every route.
 */
function HuddleWindowSurface() {
  const call = useHuddleCall()
  const prefs = useHuddlePrefs()
  const win = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const pip = usePictureInPicture()

  const active = call.status !== 'idle' && !!call.conversationId
  const web = Platform.OS === 'web'
  const fixed = web ? ({ position: 'fixed' } as object) : {}
  const narrow = win.width < 640

  const mini = { width: Math.min(MINI_WIDTH, win.width - MARGIN * 2), height: MINI_HEIGHT }
  const anchor = useCallback((c: MiniCorner) => cornerOrigin(c, win, insets, mini), [win.width, win.height, insets.top, insets.bottom])
  const drag = useCornerDrag(prefs.miniCorner, anchor, mini, win)

  // On desktop the call lives in its own window; this one shows no call surface of its own.
  const hosted = isHuddleHostedElsewhere()
  useAutoPictureInPicture(active && !hosted)
  useEffect(() => {
    if (!active) closePictureInPicture()
  }, [active])

  const prejoin = call.pending ? <HuddlePrejoin pending={call.pending} /> : null
  if (!active || hosted) return prejoin

  // With the tab hidden (or popped out), the card lives in a picture-in-picture window instead.
  if (pip.window) return <>{prejoin}<HuddlePip /></>

  if (call.view === 'expanded') {
    const full = narrow
    const width = full ? win.width : Math.min(980, win.width - 32)
    const height = full ? win.height : Math.min(680, win.height - 32)
    return (
      <>
        {prejoin}
        <View
          className="absolute z-50"
          style={{ ...fixed, left: (win.width - width) / 2, top: full ? 0 : (win.height - height) / 2, width, height, paddingTop: full ? insets.top : 0, paddingBottom: full ? insets.bottom : 0 }}
          testID="huddle-window"
        >
          <HuddlePanel />
        </View>
      </>
    )
  }

  if (call.view === 'pill') {
    return (
      <>
        {prejoin}
        <View className="absolute z-50" style={web ? ({ position: 'fixed', bottom: 16, right: 16 } as object) : { bottom: insets.bottom + 72, right: 12 }} testID="huddle-window">
          <HuddlePill onExpand={() => setHuddleView('expanded')} />
        </View>
      </>
    )
  }

  const origin = cornerOrigin(prefs.miniCorner, win, insets, mini)
  return (
    <>
      {prejoin}
      <Animated.View
        className="absolute z-50"
        style={{ ...fixed, left: origin.left, top: origin.top, width: origin.width, height: mini.height, transform: drag.pan.getTranslateTransform() }}
        {...drag.handlers}
        testID="huddle-window"
      >
        <HuddleMiniCard onExpand={() => setHuddleView('expanded')} onPill={() => setHuddleView('pill')} />
      </Animated.View>
    </>
  )
}

/**
 * The call surface. Mount once in the app layout; it renders nothing outside a call
 * (besides the pre-join preview) and floats over every route.
 *
 * On the web it is portaled to the document body. The layout mounts it inside
 * the content area next to the sidebar, and anything positioned from there is
 * offset by the sidebar and can be covered by it. In the body, the window is
 * placed against the real viewport and stacks above the sidebar.
 */
export function HuddleWindow() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return <HuddleWindowSurface />
  return createPortal(
    <div style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: 1000 }} data-testid="huddle-window-root">
      <HuddleWindowSurface />
    </div>,
    document.body,
  )
}
