// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { ChevronDown, Check, Zap, Lock } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import {
  getModelsByProvider,
  getModelShortDisplayName,
  AUTO_MODEL_ID,
  type ModelTier,
} from '@shogo/model-catalog'

export interface ModelOption {
  provider: string
  name: string
  displayName: string
  tier: ModelTier
}

export interface ModelGroup {
  label: string
  models: { id: string; displayName: string; tier: ModelTier }[]
}

const AUTO_MODEL_OPTION: ModelOption = {
  provider: 'auto',
  name: AUTO_MODEL_ID,
  displayName: 'Auto',
  tier: 'standard' as ModelTier,
}

const TIER_LABELS: Record<ModelTier, string> = {
  premium: 'Premium',
  standard: 'Standard',
  economy: 'Economy',
}

const MODEL_GROUPS: ModelGroup[] = getModelsByProvider().map((g) => ({
  label: g.label,
  models: g.models.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    tier: e.tier as ModelTier,
  })),
}))

interface ModelPickerProps {
  selectedModelId: string
  onModelChange: (modelId: string) => void
  showAutoOption?: boolean
  canSelectAllModels?: boolean
  loading?: boolean
  placement?: 'bottom left' | 'bottom right' | 'bottom'
  size?: 'sm' | 'md'
}

export function ModelPicker({
  selectedModelId,
  onModelChange,
  showAutoOption = false,
  canSelectAllModels = true,
  loading = false,
  placement = 'bottom left',
  size = 'sm',
}: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false)

  const isAutoSelected = selectedModelId === AUTO_MODEL_ID
  const displayName = getModelShortDisplayName(selectedModelId)

  const handleSelect = useCallback(
    (modelId: string) => {
      onModelChange(modelId)
      setIsOpen(false)
    },
    [onModelChange],
  )

  return (
    <Popover
      placement={placement}
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          onPress={() => setIsOpen((prev) => !prev)}
          disabled={loading}
          className={cn(
            'flex-row items-center gap-1 rounded-lg border border-border bg-muted/30',
            size === 'sm' ? 'px-2.5 py-1.5' : 'px-3 py-2',
          )}
        >
          {loading ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Text
                className={cn(
                  'font-medium text-foreground',
                  size === 'sm' ? 'text-xs' : 'text-sm',
                )}
              >
                {displayName}
              </Text>
              <ChevronDown size={12} className="text-muted-foreground" />
            </>
          )}
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="p-0 min-w-[220px]">
        <PopoverBody>
          {showAutoOption && (
            <>
              <Pressable
                onPress={() => handleSelect(AUTO_MODEL_ID)}
                className={cn(
                  'flex-row items-center gap-2.5 px-3 py-2.5',
                  'active:bg-muted',
                  isAutoSelected && 'bg-accent',
                )}
              >
                <Zap size={14} className="text-primary" />
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">Auto</Text>
                  <Text className="text-[10px] text-muted-foreground">
                    Picks the best model per turn to save cost
                  </Text>
                </View>
                {isAutoSelected && <Check size={14} className="text-primary" />}
              </Pressable>
              <View className="h-px bg-border/50 mx-2" />
            </>
          )}
          {MODEL_GROUPS.map((group) => (
            <View key={group.label}>
              <View className="px-3 pt-2.5 pb-1">
                <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </Text>
              </View>
              {group.models.map((model) => {
                const isSelected =
                  selectedModelId === model.id ||
                  (selectedModelId &&
                    model.id === selectedModelId.replace(/-\d{8}$/, ''))
                const isLocked = !canSelectAllModels && model.tier !== 'economy'
                return (
                  <Pressable
                    key={model.id}
                    onPress={() => !isLocked && handleSelect(model.id)}
                    className={cn(
                      'flex-row items-center gap-2.5 px-3 py-2',
                      isLocked ? 'opacity-50' : 'active:bg-muted',
                      isSelected && !isLocked && 'bg-accent',
                    )}
                  >
                    <View className="flex-1">
                      <Text
                        className={cn(
                          'text-sm',
                          isLocked ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        {model.displayName}
                      </Text>
                    </View>
                    {isLocked ? (
                      <View className="flex-row items-center gap-1">
                        <Lock size={10} className="text-muted-foreground" />
                        <Text className="text-[10px] font-medium text-muted-foreground">
                          Pro
                        </Text>
                      </View>
                    ) : (
                      <>
                        <Text
                          className={cn(
                            'text-[10px]',
                            model.tier === 'premium'
                              ? 'text-amber-500'
                              : model.tier === 'economy'
                                ? 'text-emerald-500'
                                : 'text-muted-foreground',
                          )}
                        >
                          {TIER_LABELS[model.tier]}
                        </Text>
                        {isSelected && <Check size={14} className="text-primary" />}
                      </>
                    )}
                  </Pressable>
                )
              })}
            </View>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
