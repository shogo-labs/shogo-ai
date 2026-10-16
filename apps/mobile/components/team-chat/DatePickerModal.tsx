// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pick a calendar date, optionally with a time, for a date chip. The result
 * is a date token value: "YYYY-MM-DD", or a UTC moment when a time is set.
 */
import { useMemo, useState } from 'react'
import { Modal, Pressable, Text, TextInput, View } from 'react-native'
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { dateValue, dayIn, formatClock, localPartsOf, localTimeZone, monthGrid, parseClockInput } from '../../lib/doc-tokens'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export interface DatePickerModalProps {
  visible: boolean
  /** The value being edited, if any. */
  initial?: string | null
  title?: string
  onCancel: () => void
  onPick: (value: string) => void
  now?: Date
  timeZone?: string | null
}

export function DatePickerModal(props: DatePickerModalProps) {
  if (!props.visible) return null
  return <DatePickerBody {...props} />
}

function DatePickerBody({ initial, title = 'Pick a date', onCancel, onPick, now = new Date(), timeZone }: DatePickerModalProps) {
  const tz = timeZone ?? localTimeZone()
  const today = dayIn(now, tz)
  const start = (initial && localPartsOf(initial, tz)) || { day: today, time: null }
  const [day, setDay] = useState(start.day)
  const [month, setMonth] = useState(() => ({ y: +start.day.slice(0, 4), m: +start.day.slice(5, 7) - 1 }))
  const [timeOn, setTimeOn] = useState(!!start.time)
  const [timeText, setTimeText] = useState(start.time ? formatClock(start.time) : '9:00 AM')
  const weeks = useMemo(() => monthGrid(month.y, month.m), [month])
  const time = timeOn ? parseClockInput(timeText) : null
  const timeInvalid = timeOn && !time

  const shift = (n: number) =>
    setMonth(({ y, m }) => {
      const t = m + n
      return { y: y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 }
    })

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onCancel}>
        <Pressable testID="date-picker" className="w-full max-w-sm rounded-xl bg-card p-4" onPress={() => {}}>
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">{title}</Text>
            <Pressable onPress={onCancel} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <View className="mb-2 flex-row items-center">
            <Pressable onPress={() => shift(-1)} accessibilityLabel="Previous month" className="rounded-md p-1 active:bg-muted hover:bg-muted">
              <ChevronLeft size={16} className="text-muted-foreground" />
            </Pressable>
            <Text className="flex-1 text-center text-sm font-medium text-foreground">
              {MONTHS[month.m]} {month.y}
            </Text>
            <Pressable onPress={() => shift(1)} accessibilityLabel="Next month" className="rounded-md p-1 active:bg-muted hover:bg-muted">
              <ChevronRight size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <View className="flex-row">
            {WEEKDAYS.map((w, i) => (
              <Text key={i} className="flex-1 text-center text-[10px] text-muted-foreground">
                {w}
              </Text>
            ))}
          </View>
          {weeks.map((week, wi) => (
            <View key={wi} className="flex-row">
              {week.map((d, di) =>
                d ? (
                  <Pressable
                    key={d}
                    onPress={() => setDay(d)}
                    accessibilityLabel={d}
                    aria-selected={d === day}
                    className={cn('m-0.5 flex-1 items-center rounded-md py-1.5', d === day ? 'bg-primary' : 'active:bg-muted hover:bg-muted')}
                  >
                    <Text className={cn('text-xs', d === day ? 'text-primary-foreground' : d === today ? 'font-bold text-primary' : 'text-foreground')}>
                      {+d.slice(8)}
                    </Text>
                  </Pressable>
                ) : (
                  <View key={`${wi}-${di}`} className="m-0.5 flex-1" />
                ),
              )}
            </View>
          ))}
          <View className="mt-3 flex-row items-center gap-2">
            <Pressable
              onPress={() => setTimeOn((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: timeOn }}
              className="flex-row items-center gap-1.5"
            >
              <View className={cn('h-3.5 w-3.5 rounded border', timeOn ? 'border-primary bg-primary' : 'border-border')} />
              <Text className="text-xs text-foreground">Add a time</Text>
            </Pressable>
            {timeOn ? (
              <TextInput
                value={timeText}
                onChangeText={setTimeText}
                accessibilityLabel="Time"
                placeholder="3:00 PM"
                className={cn('flex-1 rounded-md border px-2 py-1 text-xs text-foreground', timeInvalid ? 'border-destructive' : 'border-border')}
              />
            ) : null}
          </View>
          <View className="mt-4 flex-row justify-end gap-2">
            <Pressable onPress={onCancel} className="rounded-md px-3 py-1.5 active:bg-muted hover:bg-muted">
              <Text className="text-xs text-muted-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => !timeInvalid && onPick(dateValue(day, time, tz))}
              disabled={timeInvalid}
              accessibilityLabel="Use this date"
              className={cn('rounded-md bg-primary px-3 py-1.5', timeInvalid && 'opacity-50')}
            >
              <Text className="text-xs font-medium text-primary-foreground">Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
