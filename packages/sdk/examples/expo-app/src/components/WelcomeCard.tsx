/**
 * WelcomeCard (React Native)
 *
 * Shown when agent is connected but no surfaces exist yet.
 * "Your canvas is ready" + quick-start prompt grid.
 *
 * Web equivalent: WelcomeCard + QUICK_PROMPTS in AgentDynamicAppPanel.tsx
 */

import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { Zap, ListTodo, Calendar, MessageSquare, Bot, Send } from 'lucide-react-native'

const QUICK_PROMPTS = [
    { Icon: ListTodo, label: 'Build a task manager' },
    { Icon: Calendar, label: 'Show a daily planner' },
    { Icon: MessageSquare, label: 'Create a feedback form' },
    { Icon: Bot, label: 'Set up a personal dashboard' },
]

export default function WelcomeCard() {
    return (
        <View style={styles.container}>
            {/* Icon + heading + subtitle */}
            <View style={styles.header}>
                <View style={styles.iconRing}>
                    <Zap size={28} color="#3b82f6" strokeWidth={2} />
                </View>
                <Text style={styles.heading}>Your canvas is ready</Text>
                <Text style={styles.subtitle}>
                    Ask your agent to build interactive UIs. They&apos;ll appear here in real time.
                </Text>
            </View>

            {/* 2-column quick prompt grid */}
            <View style={styles.grid}>
                {QUICK_PROMPTS.map(({ Icon, label }) => (
                    <TouchableOpacity key={label} style={styles.promptBtn} activeOpacity={0.7}>
                        <Icon size={16} color="#9ca3af" strokeWidth={2} />
                        <Text style={styles.promptLabel}>{label}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* Footer hint */}
            <View style={styles.footer}>
                <Send size={12} color="rgba(156,163,175,0.6)" strokeWidth={2} />
                <Text style={styles.footerText}>Type a prompt in the chat panel to get started</Text>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
        gap: 32,
    },
    header: { alignItems: 'center', gap: 12 },
    iconRing: {
        width: 56,
        height: 56,
        borderRadius: 16,
        backgroundColor: 'rgba(59,130,246,0.1)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    heading: { fontSize: 18, fontWeight: '600', color: '#111827' },
    subtitle: { fontSize: 14, color: '#9ca3af', textAlign: 'center', maxWidth: 300 },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        width: '100%',
        maxWidth: 400,
        justifyContent: 'center',
    },
    promptBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderColor: 'rgba(229,231,235,0.6)',
        backgroundColor: '#fff',
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        width: '47%',
    },
    promptLabel: { fontSize: 12, color: '#9ca3af', flex: 1 },
    footer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    footerText: { fontSize: 12, color: 'rgba(156,163,175,0.6)' },
})
