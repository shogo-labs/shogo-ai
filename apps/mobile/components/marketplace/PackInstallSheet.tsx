// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The install wizard for an agent pack.
 *
 * A pack asks 2–4 questions before anything is created (what the team builds,
 * who signs off, how fast to respond) and answers land in its prompts and
 * workspace profile. Everything here is rendered from the pack's own
 * `setup.questions` — there is no per-pack UI — and the plan shown above the
 * button comes from the server's dry run of the same apply that the button
 * performs.
 */

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { X } from 'lucide-react-native'

export interface PackQuestion {
  id: string
  header: string
  question: string
  type: 'text' | 'choice' | 'multi' | 'confirm'
  options?: string[]
  default?: string | string[] | boolean
  applies?: string
  required?: boolean
}

export interface PackPreviewResponse {
  questions: PackQuestion[]
  plan: string[]
  conflicts: string[]
}

export function PackInstallSheet({
  visible,
  packName,
  preview,
  loading,
  installing,
  error,
  onCancel,
  onInstall,
  onAnswersChange,
}: {
  visible: boolean
  packName: string
  preview: PackPreviewResponse | null
  loading?: boolean
  installing?: boolean
  error?: string | null
  onCancel: () => void
  onInstall: (answers: Record<string, unknown>) => void
  /** Called with the answers so the plan can show what they actually fill in. */
  onAnswersChange?: (answers: Record<string, unknown>) => void
}) {
  const questions = preview?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, unknown>>({})

  // Answers are keyed by the `applies` path (`profile.review-time`), the same
  // key the apply engine substitutes — over HTTP the two processes never share
  // an id twice, so the question id is only the fallback.
  const keyOf = (q: PackQuestion) => q.applies ?? q.id

  useEffect(() => {
    if (!visible) return
    const defaults: Record<string, unknown> = {}
    for (const q of questions) {
      if (q.default !== undefined) defaults[keyOf(q)] = q.default
      else if (q.type === 'multi') defaults[keyOf(q)] = []
    }
    setAnswers(defaults)
  }, [visible, questions.length])

  // The plan is rendered from the answers by the same apply engine that will
  // run, so a changed answer refetches it — otherwise it keeps saying "the
  // default is used" after the person picked something else. The opening
  // preview already reflects the defaults, which is why the first pass is not
  // sent back.
  const settled = useRef(false)
  useEffect(() => {
    if (!visible || !onAnswersChange) return
    if (!settled.current) {
      settled.current = true
      return
    }
    const timer = setTimeout(() => onAnswersChange(answers), 400)
    return () => clearTimeout(timer)
  }, [answers, visible])
  useEffect(() => {
    if (!visible) settled.current = false
  }, [visible])

  const set = (key: string, value: unknown) => setAnswers((prev) => ({ ...prev, [key]: value }))

  const toggleMulti = (key: string, option: string) => {
    const current = Array.isArray(answers[key]) ? (answers[key] as string[]) : []
    const next = current.includes(option) ? current.filter((v) => v !== option) : [...current, option]
    set(key, next)
  }

  const defaultLabel = (q: PackQuestion) =>
    q.default === undefined ? null : Array.isArray(q.default) ? q.default.join(', ') : String(q.default)

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/60">
        <View className="bg-background rounded-t-3xl max-h-[92%] border-t border-border">
          <View className="flex-row items-center justify-between px-5 pt-4 pb-2">
            <Text className="text-foreground text-lg font-semibold flex-1" numberOfLines={2}>
              Set up {packName}
            </Text>
            <Pressable onPress={onCancel} hitSlop={10} className="w-8 h-8 items-center justify-center">
              <X size={20} color="#8b8b8b" />
            </Pressable>
          </View>

          <ScrollView className="px-5" contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
            {loading && (
              <View className="py-8 items-center">
                <ActivityIndicator />
                <Text className="text-muted-foreground text-sm mt-2">Checking what this will create…</Text>
              </View>
            )}

            {!loading && questions.length === 0 && (
              <Text className="text-muted-foreground text-sm py-4">
                This listing asks nothing up front — installing adds its project as usual.
              </Text>
            )}

            {!loading &&
              questions.map((q) => (
                <View key={q.id} className="mb-5">
                  <Text className="text-foreground text-sm font-medium">{q.header}</Text>
                  <Text className="text-muted-foreground text-xs mt-1 mb-2">{q.question}</Text>

                  {(q.type === 'text' || !q.type) && (
                    <TextInput
                      value={typeof answers[keyOf(q)] === 'string' ? (answers[keyOf(q)] as string) : ''}
                      onChangeText={(v) => set(keyOf(q), v)}
                      placeholder={typeof q.default === 'string' ? q.default : 'Type an answer'}
                      placeholderTextColor="#71717a"
                      className="bg-secondary text-foreground rounded-xl px-3 py-3 text-sm"
                    />
                  )}

                  {q.type === 'choice' && (
                    <View className="flex-row flex-wrap gap-2">
                      {(q.options ?? []).map((option) => {
                        const selected = answers[keyOf(q)] === option
                        return (
                          <Pressable
                            key={option}
                            onPress={() => set(keyOf(q), option)}
                            className={`px-3 py-2 rounded-xl border ${selected ? 'border-primary bg-primary/10' : 'border-border bg-secondary'}`}
                          >
                            <Text className={`text-xs ${selected ? 'text-primary' : 'text-foreground'}`}>{option}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}

                  {q.type === 'multi' && (
                    <View className="flex-row flex-wrap gap-2">
                      {(q.options ?? []).map((option) => {
                        const current = Array.isArray(answers[keyOf(q)]) ? (answers[keyOf(q)] as string[]) : []
                        const selected = current.includes(option)
                        return (
                          <Pressable
                            key={option}
                            onPress={() => toggleMulti(keyOf(q), option)}
                            className={`px-3 py-2 rounded-xl border ${selected ? 'border-primary bg-primary/10' : 'border-border bg-secondary'}`}
                          >
                            <Text className={`text-xs ${selected ? 'text-primary' : 'text-foreground'}`}>{option}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}

                  {q.type === 'confirm' && (
                    <Pressable
                      onPress={() => set(keyOf(q), answers[keyOf(q)] !== true)}
                      className={`self-start px-3 py-2 rounded-xl border ${answers[keyOf(q)] === true ? 'border-primary bg-primary/10' : 'border-border bg-secondary'}`}
                    >
                      <Text className={`text-xs ${answers[keyOf(q)] === true ? 'text-primary' : 'text-foreground'}`}>
                        {answers[keyOf(q)] === true ? 'Yes' : 'No'}
                      </Text>
                    </Pressable>
                  )}

                  {/* Every question is skippable: say what a blank one falls back to. */}
                  <Text className="text-muted-foreground text-[11px] mt-2">
                    {defaultLabel(q) !== null ? `Skippable — without an answer it uses "${defaultLabel(q)}"` : 'Skippable — leave it blank and the agent works it out'}
                  </Text>
                </View>
              ))}

            {!loading && (preview?.plan?.length ?? 0) > 0 && (
              <View className="bg-secondary rounded-2xl p-4 mb-3">
                <Text className="text-foreground text-sm font-medium mb-2">This will</Text>
                {preview!.plan.map((line) => (
                  <Text key={line} className="text-muted-foreground text-xs leading-5">
                    • {line}
                  </Text>
                ))}
              </View>
            )}

            {!loading &&
              (preview?.conflicts ?? []).map((line) => (
                <Text key={line} className="text-amber-500 text-xs mb-2">
                  {line}
                </Text>
              ))}

            {!!error && <Text className="text-red-500 text-xs mb-3">{error}</Text>}
          </ScrollView>

          <View className="px-5 pb-6 pt-2 border-t border-border">
            <Pressable
              disabled={loading || installing}
              onPress={() => onInstall(answers)}
              className={`rounded-xl py-3 items-center ${loading || installing ? 'bg-primary/50' : 'bg-primary'}`}
            >
              {installing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="text-primary-foreground text-sm font-semibold">Install</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}
