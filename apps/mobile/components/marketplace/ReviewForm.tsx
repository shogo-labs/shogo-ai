// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { View, Text, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { Star } from 'lucide-react-native'

interface ReviewFormProps {
  onSubmit: (data: { rating: number; title: string; body: string }) => Promise<void>
  existingReview?: { rating: number; title?: string; body?: string }
}

export function ReviewForm({ onSubmit, existingReview }: ReviewFormProps) {
  const [rating, setRating] = useState(existingReview?.rating ?? 0)
  const [title, setTitle] = useState(existingReview?.title ?? '')
  const [body, setBody] = useState(existingReview?.body ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (rating === 0) {
      setError('Please select a rating')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit({ rating, title, body })
    } catch (e: any) {
      setError(e.message || 'Failed to submit review')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className="gap-3">
      <Text className="text-base font-semibold text-foreground">
        {existingReview ? 'Update Your Review' : 'Write a Review'}
      </Text>

      <View className="flex-row gap-1">
        {[1, 2, 3, 4, 5].map((s) => (
          <Pressable key={s} onPress={() => setRating(s)}>
            <Star
              size={28}
              className={s <= rating ? 'text-yellow-500' : 'text-muted-foreground/30'}
              fill={s <= rating ? 'currentColor' : 'none'}
            />
          </Pressable>
        ))}
      </View>

      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Review title (optional)"
        className="px-3 py-2.5 rounded-lg border border-border bg-background text-foreground text-sm"
        placeholderTextColor="#9ca3af"
      />

      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder="Share your experience..."
        multiline
        numberOfLines={4}
        className="px-3 py-2.5 rounded-lg border border-border bg-background text-foreground text-sm min-h-[100px]"
        placeholderTextColor="#9ca3af"
        textAlignVertical="top"
      />

      {error && <Text className="text-sm text-destructive">{error}</Text>}

      <Pressable
        onPress={handleSubmit}
        disabled={submitting || rating === 0}
        className="flex-row items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary active:opacity-80 disabled:opacity-50"
      >
        {submitting && <ActivityIndicator size="small" color="white" />}
        <Text className="text-sm font-medium text-primary-foreground">
          {existingReview ? 'Update Review' : 'Submit Review'}
        </Text>
      </Pressable>
    </View>
  )
}
