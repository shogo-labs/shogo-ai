/**
 * AgentDynamicAppPanel (React Native)
 *
 * Main canvas panel — status bar, refresh button, empty/loading state.
 *
 * Web equivalent: apps/web/src/components/app/project/agent/AgentDynamicAppPanel.tsx
 *
 * PR #124 additions ported here:
 *   - reconnect / handleRefresh with 1200ms cooldown
 *   - Refresh button (RefreshCw) in status bar
 *   - Disconnected state is now a tappable button (WifiOff → handleRefresh)
 *   - Connecting spinner changed from RefreshCw → Loader2 (ActivityIndicator in RN)
 *   - SkeletonDashboard behind loading overlay
 *   - PhaseProgress indicator
 *   - WelcomeCard when connected + no surfaces
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
} from 'react-native'
import { LayoutDashboard, Wifi, WifiOff, RefreshCw, Bot } from 'lucide-react-native'
import { useDynamicAppStream } from '../hooks/use-dynamic-app-stream'
import { useLoadingPhase } from '../hooks/use-loading-phase'
import SkeletonDashboard from './SkeletonDashboard'
import PhaseProgress from './PhaseProgress'
import WelcomeCard from './WelcomeCard'

interface AgentDynamicAppPanelProps {
    agentUrl: string | null
    visible?: boolean
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function AgentDynamicAppPanel({
    agentUrl,
    visible = true,
}: AgentDynamicAppPanelProps) {
    const {
        surfaces,
        connected,
        error,
        reconnect,                    // ← PR #124: reconnect function from the hook
    } = useDynamicAppStream(visible ? agentUrl : null)

    // ─── PR #124: refresh button with 1200ms cooldown ─────────────────────────
    const [isRefreshing, setIsRefreshing] = useState(false)
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

    const handleRefresh = useCallback(() => {
        if (isRefreshing) return
        setIsRefreshing(true)
        reconnect()
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => setIsRefreshing(false), 1200)
    }, [reconnect, isRefreshing])

    useEffect(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }, [])
    // ──────────────────────────────────────────────────────────────────────────

    if (!visible) return null

    const hasSurfaces = surfaces.size > 0

    return (
        <View style={styles.container}>
            {/* ── Status Bar ────────────────────────────────────────────────────── */}
            <View style={styles.statusBar}>
                <View style={styles.statusLeft}>
                    <LayoutDashboard size={14} color="#9ca3af" strokeWidth={2} />
                    <Text style={styles.canvasLabel}>Canvas</Text>
                </View>

                <View style={styles.statusRight}>
                    {/* Error text */}
                    {error ? <Text style={styles.errorText}>{error}</Text> : null}

                    {/* ── PR #124: connection indicator ────────────────────────────── */}
                    {connected ? (
                        <View style={styles.badge}>
                            <Wifi size={12} color="#10b981" strokeWidth={2} />
                            <Text style={styles.connectedText}>Connected</Text>
                        </View>
                    ) : agentUrl ? (
                        // ← PR #124: disconnected state is now a tappable button
                        <TouchableOpacity style={styles.badge} onPress={handleRefresh} activeOpacity={0.7}>
                            <WifiOff size={12} color="#f59e0b" strokeWidth={2} />
                            <Text style={styles.disconnectedText}>Disconnected</Text>
                        </TouchableOpacity>
                    ) : (
                        // ← PR #124: Loader2/ActivityIndicator instead of RefreshCw
                        <View style={styles.badge}>
                            <ActivityIndicator size={12} color="#9ca3af" />
                            <Text style={styles.connectingText}>Connecting...</Text>
                        </View>
                    )}
                    {/* ─────────────────────────────────────────────────────────────── */}

                    {/* Divider */}
                    <View style={styles.divider} />

                    {/* ── PR #124: refresh canvas button ───────────────────────────── */}
                    <TouchableOpacity
                        style={[styles.refreshBtn, isRefreshing && styles.refreshBtnActive]}
                        onPress={handleRefresh}
                        disabled={isRefreshing}
                        activeOpacity={0.6}
                    >
                        <RefreshCw
                            size={12}
                            color={isRefreshing ? '#3b82f6' : 'rgba(156,163,175,0.6)'}
                            strokeWidth={2}
                        />
                    </TouchableOpacity>
                    {/* ─────────────────────────────────────────────────────────────── */}
                </View>
            </View>

            {/* ── Content ───────────────────────────────────────────────────────── */}
            <View style={styles.content}>
                {hasSurfaces ? (
                    // Surface count indicator — full renderer can be added later
                    <View style={styles.surfaceHint}>
                        <Text style={styles.surfaceHintText}>
                            {surfaces.size} surface{surfaces.size !== 1 ? 's' : ''} active
                        </Text>
                    </View>
                ) : (
                    <EmptyState connected={connected} agentUrl={agentUrl} />
                )}
            </View>
        </View>
    )
}

// ---------------------------------------------------------------------------
// Empty State Orchestrator  (PR #124: replaces old spinner-only empty state)
// ---------------------------------------------------------------------------

function EmptyState({
    connected,
    agentUrl,
}: {
    connected: boolean
    agentUrl: string | null
}) {
    const phase = useLoadingPhase(agentUrl, connected)

    // PR #124: when connected → show WelcomeCard instead of nothing
    if (connected) return <WelcomeCard />

    // PR #124: when loading → SkeletonDashboard behind Bot icon + PhaseProgress
    return (
        <View style={styles.emptyContainer}>
            <SkeletonDashboard />

            <View style={styles.loadingOverlay}>
                {/* Bot icon with amber pulse dot */}
                <View style={styles.botWrapper}>
                    <View style={styles.botCircle}>
                        <Bot size={24} color="#3b82f6" strokeWidth={2} />
                    </View>
                    <View style={styles.pulseDotOuter}>
                        <View style={styles.pulseDot} />
                    </View>
                </View>

                <View style={styles.loadingText}>
                    <Text style={styles.loadingTitle}>Setting up your agent</Text>
                    <Text style={styles.loadingSubtitle}>This usually takes a few seconds</Text>
                </View>

                <PhaseProgress currentPhase={phase} />
            </View>
        </View>
    )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f9fafb' },

    // Status bar
    statusBar: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        backgroundColor: 'rgba(243,244,246,0.3)',
    },
    statusLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    canvasLabel: { fontSize: 12, color: '#9ca3af' },
    statusRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },

    // Badges
    badge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    connectedText: { fontSize: 12, color: '#10b981' },
    disconnectedText: { fontSize: 12, color: '#f59e0b' },
    connectingText: { fontSize: 12, color: '#9ca3af' },
    errorText: { fontSize: 12, color: '#f59e0b', marginRight: 4 },

    // Divider
    divider: { width: 1, height: 14, backgroundColor: 'rgba(229,231,235,0.6)', marginHorizontal: 2 },

    // Refresh button
    refreshBtn: { padding: 4, borderRadius: 6 },
    refreshBtnActive: { backgroundColor: 'rgba(59,130,246,0.1)' },

    // Content
    content: { flex: 1 },
    surfaceHint: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    surfaceHintText: { fontSize: 14, color: '#9ca3af' },

    // Empty / loading state
    emptyContainer: { flex: 1, position: 'relative' },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 24,
        paddingHorizontal: 32,
    },
    botWrapper: { position: 'relative' },
    botCircle: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(59,130,246,0.1)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    pulseDotOuter: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: '#f9fafb',
        justifyContent: 'center',
        alignItems: 'center',
    },
    pulseDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#fbbf24' },
    loadingText: { alignItems: 'center', gap: 4 },
    loadingTitle: { fontSize: 14, fontWeight: '500', color: '#111827' },
    loadingSubtitle: { fontSize: 12, color: '#9ca3af' },
})
