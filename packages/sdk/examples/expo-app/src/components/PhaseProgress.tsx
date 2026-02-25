/**
 * PhaseProgress (React Native)
 *
 * Step-by-step loading indicator: initializing → starting → connecting.
 * Matches the web PhaseProgress exactly — CheckCircle2 / Loader2 / Circle icons.
 *
 * Web equivalent: PhaseProgress in AgentDynamicAppPanel.tsx
 * Icon library: lucide-react-native (same icon names as web lucide-react)
 */

import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react-native'
import { PHASE_CONFIG, type LoadingPhase } from '../hooks/use-loading-phase'

interface PhaseProgressProps {
    currentPhase: LoadingPhase
}

export default function PhaseProgress({ currentPhase }: PhaseProgressProps) {
    const currentIdx = PHASE_CONFIG.findIndex(p => p.id === currentPhase)

    return (
        <View style={styles.container}>
            {/* slice(0, -1) to exclude 'ready' — same as web version */}
            {PHASE_CONFIG.slice(0, -1).map((phase, idx) => {
                const isComplete = idx < currentIdx
                const isActive = idx === currentIdx

                return (
                    <View key={phase.id} style={styles.row}>
                        {isComplete ? (
                            <CheckCircle2 size={16} color="#10b981" strokeWidth={2} />
                        ) : isActive ? (
                            <Loader2 size={16} color="#3b82f6" strokeWidth={2} />
                        ) : (
                            <Circle size={16} color="rgba(156,163,175,0.5)" strokeWidth={2} />
                        )}
                        <Text
                            style={[
                                styles.label,
                                isComplete && styles.labelComplete,
                                isActive && styles.labelActive,
                                !isComplete && !isActive && styles.labelPending,
                            ]}
                        >
                            {phase.label}
                        </Text>
                    </View>
                )
            })}
        </View>
    )
}

const styles = StyleSheet.create({
    container: { gap: 10, width: '100%', maxWidth: 240 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    label: { fontSize: 12 },
    labelComplete: { color: '#10b981' },                         // emerald-500
    labelActive: { color: '#111827', fontWeight: '500' },        // foreground bold
    labelPending: { color: 'rgba(156,163,175,0.5)' },            // muted-foreground/50
})
