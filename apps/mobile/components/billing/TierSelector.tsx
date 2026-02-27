import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { PriceTier } from '../../lib/billing-config'

export function TierSelector({
  tiers,
  selectedIndex,
  onSelect,
  suffix = '',
}: {
  tiers: PriceTier[]
  selectedIndex: number
  onSelect: (idx: number) => void
  suffix?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = tiers[selectedIndex]

  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        className="flex-row items-center justify-between border border-border rounded-md px-3 py-2.5 bg-background"
      >
        <Text className="text-sm text-foreground">
          {selected.credits.toLocaleString()} credits{suffix}
        </Text>
        <ChevronDown size={16} className="text-muted-foreground" />
      </Pressable>
      {open && (
        <View className="border border-border rounded-md mt-1 bg-card overflow-hidden">
          {tiers.map((tier, i) => (
            <Pressable
              key={tier.credits}
              onPress={() => { onSelect(i); setOpen(false) }}
              className={cn(
                'px-3 py-2 active:bg-muted',
                i === selectedIndex && 'bg-accent'
              )}
            >
              <Text className={cn(
                'text-sm',
                i === selectedIndex ? 'text-foreground font-medium' : 'text-foreground'
              )}>
                {tier.credits.toLocaleString()} credits{suffix}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}
