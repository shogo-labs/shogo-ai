/**
 * PhaseEmptyState Component (React Native)
 *
 * Phase-contextual empty state with suggested prompts.
 * Shows phase-specific icon, title, and clickable suggestion chips.
 */

import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import {
  Compass,
  Search,
  Layers,
  Palette,
  FileText,
  TestTube,
  Hammer,
  CheckCircle,
  MessageSquare,
} from "lucide-react-native"

const PHASE_SUGGESTIONS: Record<string, string[]> = {
  discovery: [
    "Add a requirement",
    "Describe the feature",
    "What problem are we solving?",
    "Who are the users?",
  ],
  analysis: [
    "Find patterns",
    "Check integration points",
    "Identify risks",
    "Review existing code",
  ],
  classification: [
    "Validate archetype",
    "Check evidence",
    "Review patterns",
  ],
  design: [
    "Create schema",
    "Define entities",
    "Design the domain model",
  ],
  spec: [
    "Create implementation tasks",
    "Define acceptance criteria",
    "Review dependencies",
  ],
  testing: [
    "Generate test specs",
    "Define test cases",
    "Review coverage",
  ],
  implementation: [
    "Run tests",
    "Check task status",
    "Implement next task",
    "Review progress",
  ],
  complete: [
    "Review summary",
    "Create documentation",
    "Start new feature",
  ],
}

const PHASE_ICONS: Record<string, typeof MessageSquare> = {
  discovery: Compass,
  analysis: Search,
  classification: Layers,
  design: Palette,
  spec: FileText,
  testing: TestTube,
  implementation: Hammer,
  complete: CheckCircle,
}

const PHASE_TITLES: Record<string, string> = {
  discovery: "Start Discovery",
  analysis: "Explore Codebase",
  classification: "Validate Classification",
  design: "Design Schema",
  spec: "Create Implementation Spec",
  testing: "Define Tests",
  implementation: "Begin Implementation",
  complete: "Feature Complete",
}

export interface PhaseEmptyStateProps {
  phase: string | null
  onSuggestionClick?: (suggestion: string) => void
  className?: string
}

export function PhaseEmptyState({
  phase,
  onSuggestionClick,
  className,
}: PhaseEmptyStateProps) {
  const phaseKey = phase || "discovery"
  const colors = usePhaseColor(phaseKey)

  const Icon = PHASE_ICONS[phaseKey] || MessageSquare
  const title = PHASE_TITLES[phaseKey] || "Start Chatting"
  const suggestions = PHASE_SUGGESTIONS[phaseKey] || ["Type a message"]

  return (
    <View
      className={cn(
        "items-center justify-center py-8 px-4",
        className
      )}
    >
      {/* Phase icon */}
      <View
        className={cn(
          "w-12 h-12 rounded-full items-center justify-center mb-4",
          colors.bg,
          "opacity-20"
        )}
      >
        <Icon className={cn("w-6 h-6", colors.text)} size={24} />
      </View>

      {/* Title */}
      <Text className={cn("text-sm font-semibold mb-2", colors.text)}>
        {title}
      </Text>

      {/* Subtitle */}
      <Text className="text-xs text-gray-400 mb-4">
        Try one of these suggestions to get started
      </Text>

      {/* Suggestion chips */}
      <View className="flex-row flex-wrap justify-center gap-2 max-w-xs">
        {suggestions.map((suggestion) => (
          <Pressable
            key={suggestion}
            onPress={() => onSuggestionClick?.(suggestion)}
            className={cn(
              "px-3 py-1.5 rounded-full",
              "bg-gray-100/50 dark:bg-gray-800/50",
              "border border-gray-200/50 dark:border-gray-700/50"
            )}
          >
            <Text className="text-xs text-foreground">{suggestion}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

export default PhaseEmptyState
