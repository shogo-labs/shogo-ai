import { View, Text, Pressable } from 'react-native'
import { Shield, Lock, Zap, Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

type SecurityMode = 'strict' | 'balanced' | 'full_autonomy'

interface SecurityOption {
  mode: SecurityMode
  label: string
  summary: string
  description: string
  icon: typeof Shield
  recommended?: boolean
}

const OPTIONS: SecurityOption[] = [
  {
    mode: 'strict',
    label: 'Maximum Security',
    summary: 'Asks before every action',
    description: 'Agent asks before every file change or command. Best for sensitive projects.',
    icon: Lock,
  },
  {
    mode: 'balanced',
    label: 'Balanced',
    summary: 'Free inside project, asks for system actions',
    description:
      'Agent works freely inside your project but asks before running unknown commands or accessing anything outside.',
    icon: Shield,
  },
  {
    mode: 'full_autonomy',
    label: 'Full Autonomy',
    summary: 'All actions auto-approved.',
    description:
      'Agent performs all actions automatically.',
    icon: Zap,
    recommended: true,
  },
]

interface SecurityPreferenceSelectorProps {
  value?: SecurityMode
  onChange: (mode: SecurityMode) => void
  compact?: boolean
}

export function SecurityPreferenceSelector({
  value = 'full_autonomy',
  onChange,
  compact = false,
}: SecurityPreferenceSelectorProps) {
  return (
    <View className="gap-3">
      {OPTIONS.map((opt) => {
        const isSelected = value === opt.mode
        const Icon = opt.icon

        return (
          <Pressable
            key={opt.mode}
            onPress={() => onChange(opt.mode)}
            className={cn(
              'rounded-xl border-2 p-4',
              isSelected
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card',
            )}
          >
            <View className="flex-row items-start gap-3">
              <View
                className={cn(
                  'w-10 h-10 rounded-lg items-center justify-center',
                  isSelected ? 'bg-primary/10' : 'bg-muted',
                )}
              >
                <Icon
                  size={20}
                  className={isSelected ? 'text-primary' : 'text-muted-foreground'}
                />
              </View>

              <View className="flex-1 gap-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-base font-semibold text-foreground">
                    {opt.label}
                  </Text>
                  {opt.recommended && (
                    <View className="bg-primary/10 px-2 py-0.5 rounded-md">
                      <Text className="text-xs font-medium text-primary">
                        Recommended
                      </Text>
                    </View>
                  )}
                </View>
                <Text className="text-sm text-muted-foreground leading-5">
                  {compact ? opt.summary : opt.description}
                </Text>
              </View>

              {isSelected && (
                <View className="w-6 h-6 rounded-full bg-primary items-center justify-center">
                  <Check size={14} className="text-primary-foreground" />
                </View>
              )}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

export default SecurityPreferenceSelector
