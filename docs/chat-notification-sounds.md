# Chat notification sounds

This document lists every audio notification in Shogo chat: what each sound is, and the conditions under which it plays on web, desktop, and phones.

On web and desktop, chat messages play the tone chosen under "Message tone" in Settings > Chat. The default is the Soft Knock recording (`apps/mobile/assets/sounds/soft-knock.mp3`, 2 seconds). The default huddle ring plays the Llamada Clara recording (`apps/mobile/assets/sounds/llamada-clara.mp3`, 18.5 seconds). All other in-app sounds are synthesized with Web Audio. Phones don't use these sounds. They rely on the system notification sound, vibration, or the system call screen.

## Sound inventory

| Sound | What it is for | How it sounds | Source |
|---|---|---|---|
| Soft Knock | Every chat message alert: DMs, mentions, thread replies, keywords, agent questions (default tone) | Recorded soft knock, 2 s | `apps/mobile/assets/sounds/soft-knock.mp3`, played by `apps/mobile/lib/notification-sound.ts` |
| Chirp tone | Message alerts, when chosen | The synthesized `dm`, `mention`, `thread`, and `other` cues below, always | `apps/mobile/lib/notification-sound.ts` |
| Pristine, Definite, Juntos | Message alerts, when chosen | Recorded chimes: 2 s (trimmed), 2.1 s, 3.2 s | `apps/mobile/assets/sounds/{pristine,definite,juntos}.mp3` |
| Confirmation, Question, Glass | Message alerts, when chosen | Short recorded UI cues: 0.5 s, 0.5 s, 0.3 s | `apps/mobile/assets/sounds/{confirmation,question,glass}.mp3` |
| Fallback cue: `dm` | Direct and group direct messages, until the recording has loaded | Two rising notes (880 Hz, then 1318 Hz) | `apps/mobile/lib/notification-sound.ts` |
| Fallback cue: `mention` | @mentions, `@channel`, `@here`, until the recording has loaded | Two higher rising notes (1047 Hz, then 1568 Hz) | same |
| Fallback cue: `thread` | Replies in a thread you follow, until the recording has loaded | One soft note (740 Hz, 160 ms) | same |
| Fallback cue: `other` | Keywords, "all messages" channels, agent questions, until the recording has loaded | One short soft note (740 Hz, 120 ms) | same |
| Huddle `ring` | Incoming huddle (default) | Recorded ringtone, 18.5 s; loops for a direct call, plays once for a group huddle | `apps/mobile/assets/sounds/llamada-clara.mp3`, played by `apps/mobile/lib/huddle-ringtone.ts` |
| Fallback cue: `ring` | Incoming huddle, until the ringtone recording has loaded | Two-tone chirp (880 Hz, then 660 Hz), repeats every 2.4 s | same |
| Huddle `chime` | Incoming huddle (alternative) | Three-note chime, repeats every 3.2 s | same |
| Island `needs-you` | Desktop island: an agent needs input | Two rising notes | `apps/mobile/components/island/island-sounds.ts` |
| Island `done` | Desktop island: an agent session finished | Two notes, softer | same |
| Island `error` | Desktop island: an error notice | Two falling low notes | same |
| Island `sent` | Desktop island: you sent a message from it | One short high blip | same |
| System notification sound | OS banners and phone pushes | Whatever the OS or browser plays | OS |
| Vibration | Incoming huddle on a phone | Pattern of two buzzes | `huddle-ringtone.ts` |
| System call ringtone | Incoming direct call on a phone (CallKit or CallKeep) | The phone's ringtone | `apps/mobile/lib/native-call` |

The message sounds and huddle sounds share one audio context. The browser only allows it to start after the first click or key press in the app. Until then, message sounds stay silent. The recording for the chosen tone is fetched and decoded on that first click or key press. If a message arrives before it has loaded, or if the file can't be loaded, the matching fallback cue plays instead.

With several tabs of the same account open in one browser profile, only one tab plays the cue for a given message. The first tab with running audio takes a Web Lock for that message and the others stay quiet; a tab whose audio hasn't started never takes the lock. Separate browsers or apps can't share the lock, so each still plays its own cue. A second alert inside the throttle window plays no cue, and its OS banner is silent too, so the system's default sound never stacks on the chosen tone.

Saving chat settings sends a `settings.changed` event to that person's other open tabs and devices, so a tone change applies everywhere right away instead of after a reload.

## Step 1: who gets a chat alert (server)

Every alert starts on the server, in `apps/api/src/services/conversation-notifications.ts`. For each new message, the server picks the strongest reason for each member. The author is never alerted about their own message.

| Reason | When it applies | Fallback cue on web and desktop (before Soft Knock loads) |
|---|---|---|
| `mention` | You are @mentioned and you are a member of the channel. This cuts through mute, but not a level of "none". | `mention` |
| `dm` | A message in a direct or group direct message, unless you muted it | `dm` |
| `keyword` | The message matches one of your keywords (channels only) | `other` |
| `broadcast` | `@channel`, or `@here` while you are active | `mention` |
| `thread` | A reply in a thread you started or replied to | `thread` |
| `message` | A new top-level channel post, and your level for that channel is "all" | `other` |
| `question` | An agent asked you something you weren't tagged in | `other` |

No alert is sent in these cases:

- The conversation is muted, or your level for it is "none". Direct mentions still get through mute.
- You have Do Not Disturb on, or you are in your quiet hours. The item still lands in the Activity inbox, but no alert or sound goes out.
- An agent's message is still being written (the agent is running).
- An agent posts a routine update (status or result), and your level for that channel isn't "all". Agent decisions and alerts still notify.
- The message is a system message or an Activity item.

For each recipient who isn't silenced, the server does two things:

1. It sends a realtime `notification` event to every open client of that person.
2. It sends a phone push, but only when the person isn't active on any device, unless their push timing is "immediate". Pushes for the same conversation are grouped within 15 seconds. If timing is "after 5 or 10 minutes", the push waits, and it is cancelled if the person comes back or reads the conversation.

## Step 2: what plays for a chat message

### Web browser and desktop app

`apps/mobile/components/team-chat/TeamChatNotifier.tsx` handles the realtime event. It only listens to the workspace that is open.

1. If the conversation is on screen and the window is focused, nothing plays and no banner shows.
2. Otherwise, it plays the Soft Knock at the "Message sound" level (Default or Subtle). The sound is skipped when:
   - Message sound is Off.
   - Another message sound played less than 2 seconds ago.
   - The audio context isn't unlocked yet, because there hasn't been a click or key press since the page loaded.
3. It shows an OS banner if notification permission is granted (the desktop app always can).
   - If the message sound played, the banner is silent, so you don't hear two sounds.
   - If the message sound didn't play, the banner isn't silent, so the OS or browser may play its own sound.
4. On desktop, it also bounces the dock icon (macOS) or flashes the taskbar (Windows). This makes no sound.

The cue plays even when banners are blocked, so a message is audible even if Chrome or Safari hides the banner.

### Phone, app in the foreground

The in-app engine does nothing on phones. When a `notification` event arrives and the conversation isn't on screen, the app posts a local notification with the system default sound. The notification handler doesn't play a sound if that conversation is already visible.

### Phone, app in the background or closed

The phone gets the server push on the `messages` channel. The push asks for the system sound unless Message sound is Off, in which case the server sends it without a sound. Approval requests use the same channel, with Approve and Deny buttons.

## Step 3: what plays for an incoming huddle

Only direct and group direct messages ring. A huddle started in a channel doesn't ring anyone.

The server (`ringMembers` in `apps/api/src/services/huddle.service.ts`) skips people who muted the conversation, or who are in Do Not Disturb or quiet hours. It sends a `huddle.ring` event to everyone else's open clients. A ring stops when the huddle is answered, declined, or ended, or after 45 seconds.

### Web browser and desktop app

`apps/mobile/components/team-chat/HuddleRinger.tsx` shows the incoming call card and plays the "Huddle sound":

- Ring or Chime. A direct call loops until it stops, and a group huddle plays once.
- Ring is the Llamada Clara recording. It's fetched and decoded on the first ring; until then the two-tone chirp plays, and a looping ring switches to the recording once it's ready. The settings Preview plays the first 6 seconds.
- This plays even while you are using the app.
- When the window is hidden or unfocused, it also shows an OS banner, which may play the OS sound.
- Off means no ringtone.

### Phone, app in the foreground

The incoming call card shows and the phone vibrates. No synthesized ringtone plays. If the system call screen is already ringing for this call, the phone doesn't vibrate a second time.

### Phone, app in the background or closed

The server sends a push only to people who aren't active. It routes each device differently:

| Device | Direct call | Group huddle, or huddle sound Off |
|---|---|---|
| iPhone with a VoIP token | PushKit call, shown on the system call screen with the phone's ringtone | Alert push |
| Android | Data-only push, which the app turns into a ringing call | Alert push |
| Other or no VoIP token | Alert push on the `huddle-calls` channel, with sound | Alert push on the `messages` channel |

The alert push asks for the system sound unless Huddle sound is Off. If a PushKit call fails, that iPhone gets the alert push instead. When the ring ends, a `huddle-ring-cancel` push stops it on every phone.

On iOS, turning off "Announce huddle calls" clears the VoIP token, so that iPhone gets the alert push instead of the call screen.

## Step 4: what plays when an agent chat finishes

When an agent finishes a reply in a project chat (`apps/mobile/components/chat/useNotifyOnTurnComplete.ts`):

- **Web and desktop:** an OS notification shows when the tab is hidden or unfocused, and the "notify on turn complete" preference is on. It uses the OS default sound. No synthesized cue plays.
- **Phone:** the server sends a `chat-complete` push. If the phone has no push registration, the app posts a local notification with the system default sound instead.

## Step 5: desktop island sounds

The floating Shogo Island in the desktop app plays its own cues. Sounds are on or off, at the volume chosen in Settings, under Appearance (`apps/mobile/components/island/IslandApp.tsx`). Sessions the user is looking at in a focused Shogo window stay silent.

| Cue | When it plays |
|---|---|
| `needs-you` | A session asks for approval or proposes a plan, or a meeting asks a question |
| `done` | A session goes from running to done |
| `error` | A new error notice, or a meeting error |
| `sent` | You send a message from the island |

## Settings that affect sound

| Setting | Scope | Effect |
|---|---|---|
| Message sound: Default, Subtle, Off | Per workspace | Web and desktop cue volume. Off also makes phone pushes silent. Subtle has no effect on phones. |
| Message tone: Soft Knock, Chirp, Pristine, Definite, Juntos, Confirmation, Question, Glass | Per workspace, web and desktop only | Which sound a message plays. Choosing one plays a preview. Phones keep the system sound. |
| Huddle sound: Ring, Chime, Off | Per workspace | Ringtone on web and desktop. Off also stops phone vibration and makes ring pushes silent. |
| Notification level: All, Mentions, None | Per channel, with a workspace default | Which messages produce a reason at all |
| Mute | Per conversation | No alerts, except direct mentions. No huddle ring. |
| Keywords | Per workspace | Adds the `keyword` reason in channels |
| Do Not Disturb and quiet hours | Per workspace | No alerts or rings. Inbox items are still created. |
| Mobile push timing | Per workspace | When the phone push goes out |
| Announce huddle calls | iOS device | Off means no system call screen for huddles |
| Island sounds and volume | Desktop app | Island cues |
| Notify on turn complete | Device | Agent chat reply notifications |

## Known gaps

These behaviors probably don't match what a user expects from the settings:

1. **Message sound Off doesn't fully silence web and desktop.** The banner is created with `silent: false` whenever the message sound didn't play, including when the setting is Off (asserted in `TeamChatNotifier.rtl.test.tsx`). The OS or browser can still play its own sound.
2. **Message sound Off is ignored on a phone in the foreground.** `TeamChatNotifier` only loads chat settings on web. The local notification on the phone always asks for `sound: 'default'`.
3. **Android pushes may play sound even when Off.** The `messages` and `chat-complete` Android channels are created with a sound. On Android 8 and later, the channel's sound usually wins over the push payload. This should be confirmed on a device.
4. **Some pushes have no sound on iOS.** Agent question pushes (`agent-question`) and agent chat completion pushes (`chat-complete`) don't set `sound`, so they arrive silently on an iPhone.
5. **Subtle has no effect on phones.** The server only distinguishes Off from everything else.

## Credits

- Pristine, Definite, and Juntos are from [Notification Sounds](https://notificationsounds.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). They were re-encoded and peak-normalized, and Pristine was trimmed to 2 seconds with a fade-out.
- Confirmation (`confirmation_002`), Question (`question_001`), and Glass (`glass_001`) are from Kenney's [Interface Sounds](https://kenney.nl/assets/interface-sounds), released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). They were re-encoded to MP3 and peak-normalized.
