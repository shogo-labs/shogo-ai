// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { forwardRef } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import { cn } from './cn'

export interface InputProps {
  value?: string
  onChangeText?: (text: string) => void
  placeholder?: string
  secureTextEntry?: boolean
  className?: string
  disabled?: boolean
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'
  autoCorrect?: boolean
  keyboardType?: TextInputProps['keyboardType']
  multiline?: boolean
  numberOfLines?: number
  placeholderTextColor?: string
  onSubmitEditing?: () => void
  returnKeyType?: TextInputProps['returnKeyType']
  autoFocus?: boolean
  onBlur?: () => void
  onFocus?: () => void
  blurOnSubmit?: boolean
}

export const Input = forwardRef<TextInput, InputProps>(function Input({
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  className,
  disabled,
  autoCapitalize,
  autoCorrect,
  keyboardType,
  multiline,
  numberOfLines,
  placeholderTextColor,
  onSubmitEditing,
  returnKeyType,
  autoFocus,
  onBlur,
  onFocus,
  blurOnSubmit,
}, ref) {
  return (
    <TextInput
      ref={ref}
      className={cn(
        'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground',
        multiline ? 'min-h-[80px]' : 'h-10',
        disabled && 'opacity-50',
        className,
      )}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor || '#71717a'}
      secureTextEntry={secureTextEntry}
      editable={!disabled}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      keyboardType={keyboardType}
      multiline={multiline}
      numberOfLines={numberOfLines}
      onSubmitEditing={onSubmitEditing}
      returnKeyType={returnKeyType}
      autoFocus={autoFocus}
      onBlur={onBlur}
      onFocus={onFocus}
      blurOnSubmit={blurOnSubmit}
    />
  )
})
