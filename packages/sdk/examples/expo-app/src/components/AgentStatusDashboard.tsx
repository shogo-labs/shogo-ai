/**
 * AgentStatusDashboard (React Native)
 *
 * Real-time agent status dashboard that polls /agent/status every 5s.
 * 6 sections: Stats, Channels, Cron Jobs, Memory, Sessions, Heartbeat.
 *
 * Port of: apps/web/src/components/app/project/agent/AgentStatusDashboard.tsx
 * Commit: 8fa3b11 — status tab for real-time agent monitoring
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
    StyleSheet,
} from 'react-native'
import {
    Activity,
    Radio,
    Clock,
    Brain,
    Timer,
    RefreshCw,
    CheckCircle,
    XCircle,
    WifiOff,
    Calendar,
    MessageSquare,
    Zap,
    HardDrive,
    Users,
} from 'lucide-react-native'

const POLL_INTERVAL_MS = 5_000

// ── Types ──────────────────────────────────────────────────────────────────

interface ChannelInfo {
    type: string
    connected: boolean
    error?: string
    metadata?: Record<string, unknown>
}

interface CronJobInfo {
    name: string
    intervalSeconds: number
    enabled: boolean
    lastRunAt: string | null
}

interface SessionInfo {
    id: string
    messageCount: number
    estimatedTokens: number
    compactedSummary: boolean
    compactionCount: number
    idleSeconds: number
}

interface MemoryInfo {
    fileCount: number
    totalSizeBytes: number
    lastModified: string | null
}

interface AgentStatusData {
    running: boolean
    uptimeSeconds: number
    heartbeat: {
        enabled: boolean
        intervalSeconds: number
        lastTick: string | null
        nextTick: string | null
        quietHours: { start: string; end: string; timezone: string }
    }
    channels: ChannelInfo[]
    skills: Array<{ name: string; trigger: string; description: string; native?: boolean }>
    model: { provider: string; name: string }
    sessions?: SessionInfo[]
    cronJobs?: CronJobInfo[]
    memory?: MemoryInfo
}

interface AgentStatusDashboardProps {
    agentUrl: string
    visible?: boolean
}

const CHANNEL_META: Record<string, { name: string; icon: string }> = {
    telegram: { name: 'Telegram', icon: '📱' },
    discord: { name: 'Discord', icon: '🎮' },
    email: { name: 'Email', icon: '📧' },
    whatsapp: { name: 'WhatsApp', icon: '💬' },
    slack: { name: 'Slack', icon: '💼' },
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
    if (!seconds || seconds < 0 || !Number.isFinite(seconds)) return '0s'
    const s = Math.floor(seconds)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60}s`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ${m % 60}m`
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatInterval(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    return `${(seconds / 3600).toFixed(1)}h`
}

function timeAgo(dateStr: string | null): string {
    if (!dateStr) return 'Never'
    const diff = Date.now() - new Date(dateStr).getTime()
    if (diff < 60_000) return 'Just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function AgentStatusDashboard({ agentUrl, visible = true }: AgentStatusDashboardProps) {
    const [status, setStatus] = useState<AgentStatusData | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch(`${agentUrl}/agent/status`)
            if (!res.ok) throw new Error('Agent not reachable')
            const data: AgentStatusData = await res.json()
            setStatus(data)
            setError(null)
            setLastFetchedAt(Date.now())
        } catch (err: any) {
            setError(err.message)
        }
    }, [agentUrl])

    const loadInitial = useCallback(async () => {
        setIsLoading(true)
        await fetchStatus()
        setIsLoading(false)
    }, [fetchStatus])

    useEffect(() => {
        if (!visible) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
            return
        }
        loadInitial()
        pollRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS)
        return () => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        }
    }, [visible, loadInitial, fetchStatus])

    const connectedChannels = status?.channels.filter(c => c.connected).length ?? 0
    const totalChannels = status?.channels.length ?? 0
    const enabledCrons = status?.cronJobs?.filter(j => j.enabled).length ?? 0
    const totalCrons = status?.cronJobs?.length ?? 0
    const totalSessions = status?.sessions?.length ?? 0
    const totalTokens = status?.sessions?.reduce((acc, s) => acc + s.estimatedTokens, 0) ?? 0

    if (!visible) return null

    return (
        <View style={styles.container}>
            {/* ── Header ── */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Activity size={16} color="#9ca3af" strokeWidth={2} />
                    <Text style={styles.headerTitle}>Agent Status</Text>
                    {status ? (
                        <View style={styles.statusPill}>
                            <View style={[styles.statusDot, { backgroundColor: status.running ? '#10b981' : '#9ca3af' }]} />
                            <Text style={[styles.statusDotLabel, { color: status.running ? '#10b981' : '#9ca3af' }]}>
                                {status.running ? 'Running' : 'Stopped'}
                            </Text>
                        </View>
                    ) : null}
                </View>
                <View style={styles.headerRight}>
                    {lastFetchedAt && !error ? (
                        <View style={styles.liveDot}>
                            <View style={styles.liveDotInner} />
                            <Text style={styles.liveText}>Live</Text>
                        </View>
                    ) : null}
                    <TouchableOpacity style={styles.refreshBtn} onPress={loadInitial}>
                        {isLoading ? (
                            <ActivityIndicator size={14} color="#9ca3af" />
                        ) : (
                            <RefreshCw size={14} color="#9ca3af" strokeWidth={2} />
                        )}
                    </TouchableOpacity>
                </View>
            </View>

            {/* ── Error Banner ── */}
            {error ? (
                <View style={styles.errorBar}>
                    <WifiOff size={12} color="#ef4444" strokeWidth={2} />
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            ) : null}

            {/* ── Content ── */}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                {isLoading && !status ? (
                    <View style={styles.centerEmpty}>
                        <ActivityIndicator size="large" color="#9ca3af" />
                        <Text style={styles.centerEmptyText}>Loading agent status...</Text>
                    </View>
                ) : !status ? (
                    <View style={styles.centerEmpty}>
                        <Activity size={32} color="rgba(156,163,175,0.5)" strokeWidth={2} />
                        <Text style={styles.centerEmptyText}>Unable to connect to agent</Text>
                        <Text style={styles.centerEmptyHint}>Start the agent to see its status</Text>
                    </View>
                ) : (
                    <View style={styles.dashboardContent}>
                        {/* ── Stats Row ── */}
                        <View style={styles.statsRow}>
                            <StatCard icon={<Timer size={16} color="#10b981" strokeWidth={2} />} label="Uptime" value={formatUptime(status.uptimeSeconds)} />
                            <StatCard icon={<Radio size={16} color={connectedChannels > 0 ? '#3b82f6' : '#9ca3af'} strokeWidth={2} />} label="Channels" value={`${connectedChannels}/${totalChannels}`} />
                            <StatCard icon={<Clock size={16} color={enabledCrons > 0 ? '#f59e0b' : '#9ca3af'} strokeWidth={2} />} label="Cron Jobs" value={`${enabledCrons}/${totalCrons}`} />
                            <StatCard icon={<Brain size={16} color="#a855f7" strokeWidth={2} />} label="Memory" value={status.memory ? `${status.memory.fileCount} files` : '0 files'} />
                        </View>

                        {/* ── Channels ── */}
                        <DashboardSection title="Channels" icon={<MessageSquare size={14} color="#9ca3af" strokeWidth={2} />} badge={`${connectedChannels} connected`}>
                            {status.channels.length === 0 ? (
                                <EmptyRow text="No channels configured" />
                            ) : (
                                <View style={styles.sectionItems}>
                                    {status.channels.map((ch) => {
                                        const meta = CHANNEL_META[ch.type] || { name: ch.type, icon: '📡' }
                                        return (
                                            <View key={ch.type} style={styles.listRow}>
                                                <Text style={styles.channelIcon}>{meta.icon}</Text>
                                                <View style={styles.listRowInfo}>
                                                    <Text style={styles.listRowTitle}>{meta.name}</Text>
                                                    {ch.error ? <Text style={styles.listRowError}>{ch.error}</Text> : null}
                                                </View>
                                                {ch.connected ? (
                                                    <View style={styles.statusTag}>
                                                        <CheckCircle size={14} color="#10b981" strokeWidth={2} />
                                                        <Text style={[styles.statusTagText, { color: '#10b981' }]}>Online</Text>
                                                    </View>
                                                ) : (
                                                    <View style={styles.statusTag}>
                                                        <XCircle size={14} color="#ef4444" strokeWidth={2} />
                                                        <Text style={[styles.statusTagText, { color: '#ef4444' }]}>Offline</Text>
                                                    </View>
                                                )}
                                            </View>
                                        )
                                    })}
                                </View>
                            )}
                        </DashboardSection>

                        {/* ── Cron Jobs ── */}
                        <DashboardSection title="Cron Jobs" icon={<Calendar size={14} color="#9ca3af" strokeWidth={2} />} badge={`${enabledCrons} active`}>
                            {!status.cronJobs || status.cronJobs.length === 0 ? (
                                <EmptyRow text="No cron jobs scheduled" />
                            ) : (
                                <View style={styles.sectionItems}>
                                    {status.cronJobs.map((job) => (
                                        <View key={job.name} style={styles.listRow}>
                                            <View style={[styles.cronDot, { backgroundColor: job.enabled ? '#10b981' : 'rgba(156,163,175,0.4)' }]} />
                                            <View style={styles.listRowInfo}>
                                                <Text style={styles.listRowTitle}>{job.name}</Text>
                                                <Text style={styles.listRowSub}>Every {formatInterval(job.intervalSeconds)}</Text>
                                            </View>
                                            <View style={styles.listRowRight}>
                                                <Text style={[styles.listRowRightTop, { color: job.enabled ? '#10b981' : '#9ca3af' }]}>
                                                    {job.enabled ? 'Active' : 'Disabled'}
                                                </Text>
                                                <Text style={styles.listRowRightBottom}>{timeAgo(job.lastRunAt)}</Text>
                                            </View>
                                        </View>
                                    ))}
                                </View>
                            )}
                        </DashboardSection>

                        {/* ── Memory ── */}
                        <DashboardSection title="Memory" icon={<HardDrive size={14} color="#9ca3af" strokeWidth={2} />}>
                            {!status.memory || status.memory.fileCount === 0 ? (
                                <EmptyRow text="No memory files yet" />
                            ) : (
                                <View style={styles.gridRow3}>
                                    <View style={styles.gridCell}>
                                        <Text style={styles.gridLabel}>Files</Text>
                                        <Text style={styles.gridValue}>{status.memory.fileCount}</Text>
                                    </View>
                                    <View style={styles.gridCell}>
                                        <Text style={styles.gridLabel}>Total Size</Text>
                                        <Text style={styles.gridValue}>{formatBytes(status.memory.totalSizeBytes)}</Text>
                                    </View>
                                    <View style={styles.gridCell}>
                                        <Text style={styles.gridLabel}>Last Updated</Text>
                                        <Text style={styles.gridValue}>{timeAgo(status.memory.lastModified)}</Text>
                                    </View>
                                </View>
                            )}
                        </DashboardSection>

                        {/* ── Sessions ── */}
                        <DashboardSection title="Sessions" icon={<Users size={14} color="#9ca3af" strokeWidth={2} />} badge={`${totalSessions} active`}>
                            {!status.sessions || status.sessions.length === 0 ? (
                                <EmptyRow text="No active sessions" />
                            ) : (
                                <View style={styles.sectionItems}>
                                    {status.sessions.map((session) => (
                                        <View key={session.id} style={styles.listRow}>
                                            <Zap size={14} color="#f59e0b" strokeWidth={2} />
                                            <View style={styles.listRowInfo}>
                                                <Text style={styles.sessionId} numberOfLines={1}>{session.id}</Text>
                                                <Text style={styles.listRowSub}>
                                                    {session.messageCount} msgs · ~{(session.estimatedTokens / 1000).toFixed(1)}k tokens
                                                </Text>
                                            </View>
                                            <View style={styles.listRowRight}>
                                                {session.compactedSummary ? (
                                                    <Text style={styles.compactedText}>Compacted x{session.compactionCount}</Text>
                                                ) : null}
                                                <Text style={styles.listRowRightBottom}>Idle {formatUptime(session.idleSeconds)}</Text>
                                            </View>
                                        </View>
                                    ))}
                                    <View style={styles.tokenSummary}>
                                        <Text style={styles.tokenSummaryLabel}>Total estimated tokens</Text>
                                        <Text style={styles.tokenSummaryValue}>{(totalTokens / 1000).toFixed(1)}k</Text>
                                    </View>
                                </View>
                            )}
                        </DashboardSection>

                        {/* ── Heartbeat ── */}
                        <DashboardSection title="Heartbeat" icon={<Activity size={14} color="#9ca3af" strokeWidth={2} />}>
                            <View style={styles.gridRow4}>
                                <View style={styles.gridCell}>
                                    <Text style={styles.gridLabel}>Status</Text>
                                    <Text style={[styles.gridValue, { color: status.heartbeat.enabled ? '#10b981' : '#9ca3af' }]}>
                                        {status.heartbeat.enabled ? 'Enabled' : 'Disabled'}
                                    </Text>
                                </View>
                                <View style={styles.gridCell}>
                                    <Text style={styles.gridLabel}>Interval</Text>
                                    <Text style={styles.gridValue}>{formatInterval(status.heartbeat.intervalSeconds)}</Text>
                                </View>
                                <View style={styles.gridCell}>
                                    <Text style={styles.gridLabel}>Last Tick</Text>
                                    <Text style={styles.gridValue}>{timeAgo(status.heartbeat.lastTick)}</Text>
                                </View>
                                <View style={styles.gridCell}>
                                    <Text style={styles.gridLabel}>Next Tick</Text>
                                    <Text style={styles.gridValue}>
                                        {status.heartbeat.nextTick ? new Date(status.heartbeat.nextTick).toLocaleTimeString() : '-'}
                                    </Text>
                                </View>
                            </View>
                            {status.heartbeat.quietHours.start && status.heartbeat.quietHours.end ? (
                                <View style={styles.quietHours}>
                                    <Text style={styles.quietHoursText}>
                                        Quiet hours: {status.heartbeat.quietHours.start} - {status.heartbeat.quietHours.end} ({status.heartbeat.quietHours.timezone})
                                    </Text>
                                </View>
                            ) : null}
                        </DashboardSection>

                        {/* ── Model Info ── */}
                        <View style={styles.modelBar}>
                            <Zap size={14} color="#9ca3af" strokeWidth={2} />
                            <Text style={styles.modelLabel}>Model:</Text>
                            <Text style={styles.modelName}>{status.model.name}</Text>
                            <Text style={styles.modelProvider}>({status.model.provider})</Text>
                        </View>
                    </View>
                )}
            </ScrollView>
        </View>
    )
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <View style={styles.statCard}>
            <View style={styles.statCardTop}>
                {icon}
                <Text style={styles.statCardLabel}>{label}</Text>
            </View>
            <Text style={styles.statCardValue}>{value}</Text>
        </View>
    )
}

function DashboardSection({
    title,
    icon,
    badge,
    children,
}: {
    title: string
    icon: React.ReactNode
    badge?: string
    children: React.ReactNode
}) {
    return (
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                {icon}
                <Text style={styles.sectionTitle}>{title}</Text>
                {badge ? <Text style={styles.sectionBadge}>{badge}</Text> : null}
            </View>
            {children}
        </View>
    )
}

function EmptyRow({ text }: { text: string }) {
    return (
        <View style={styles.emptyRow}>
            <Text style={styles.emptyRowText}>{text}</Text>
        </View>
    )
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    // Header
    header: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: '#e5e7eb', backgroundColor: 'rgba(243,244,246,0.3)',
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    headerTitle: { fontSize: 14, fontWeight: '500', color: '#111827' },
    statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 4 },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusDotLabel: { fontSize: 12 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    liveDot: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    liveDotInner: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(16,185,129,0.7)' },
    liveText: { fontSize: 10, color: 'rgba(156,163,175,0.6)' },
    refreshBtn: { padding: 4, borderRadius: 6 },

    // Error
    errorBar: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(239,68,68,0.1)',
    },
    errorText: { fontSize: 12, color: '#ef4444', flex: 1 },

    // Scroll
    scroll: { flex: 1 },
    scrollContent: { padding: 16 },

    // Center-empty
    centerEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 64, gap: 12 },
    centerEmptyText: { fontSize: 14, color: '#9ca3af' },
    centerEmptyHint: { fontSize: 12, color: 'rgba(156,163,175,0.7)' },

    // Dashboard
    dashboardContent: { gap: 16 },

    // Stats row
    statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    statCard: {
        flex: 1, minWidth: '45%',
        gap: 6, paddingHorizontal: 12, paddingVertical: 10,
        borderRadius: 10, borderWidth: 1, borderColor: 'rgba(229,231,235,0.4)', backgroundColor: '#fff',
    },
    statCardTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statCardLabel: { fontSize: 10, fontWeight: '500', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 },
    statCardValue: { fontSize: 18, fontWeight: '600', color: '#111827' },

    // Section
    section: { borderRadius: 10, borderWidth: 1, borderColor: 'rgba(229,231,235,0.4)', overflow: 'hidden' },
    sectionHeader: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 12, paddingVertical: 8,
        backgroundColor: 'rgba(243,244,246,0.3)', borderBottomWidth: 1, borderBottomColor: 'rgba(229,231,235,0.3)',
    },
    sectionTitle: { fontSize: 12, fontWeight: '500', color: '#111827' },
    sectionBadge: { fontSize: 10, color: '#9ca3af', marginLeft: 'auto' },
    sectionItems: { gap: 0 },

    // List rows
    listRow: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingHorizontal: 12, paddingVertical: 8,
        backgroundColor: 'rgba(243,244,246,0.4)', marginHorizontal: 4, marginVertical: 2, borderRadius: 6,
    },
    channelIcon: { fontSize: 16 },
    listRowInfo: { flex: 1 },
    listRowTitle: { fontSize: 14, fontWeight: '500', color: '#111827' },
    listRowSub: { fontSize: 12, color: '#9ca3af' },
    listRowError: { fontSize: 12, color: '#ef4444' },
    listRowRight: { alignItems: 'flex-end' },
    listRowRightTop: { fontSize: 12 },
    listRowRightBottom: { fontSize: 10, color: '#9ca3af' },
    statusTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    statusTagText: { fontSize: 12 },
    cronDot: { width: 8, height: 8, borderRadius: 4 },

    // Session
    sessionId: { fontSize: 14, fontWeight: '500', fontFamily: 'monospace', color: '#111827' },
    compactedText: { fontSize: 10, color: '#3b82f6' },
    tokenSummary: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: 12, paddingVertical: 6,
    },
    tokenSummaryLabel: { fontSize: 12, color: '#9ca3af' },
    tokenSummaryValue: { fontSize: 12, fontWeight: '500', color: '#9ca3af' },

    // Grid
    gridRow3: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
    gridRow4: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
    gridCell: { flex: 1, minWidth: '40%' },
    gridLabel: { fontSize: 12, color: '#9ca3af' },
    gridValue: { fontSize: 14, fontWeight: '600', color: '#111827' },

    // Quiet hours
    quietHours: { paddingHorizontal: 12, paddingBottom: 8 },
    quietHoursText: { fontSize: 12, color: '#9ca3af' },

    // Model bar
    modelBar: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 12, paddingVertical: 8,
        borderRadius: 10, borderWidth: 1, borderColor: 'rgba(229,231,235,0.4)', backgroundColor: 'rgba(243,244,246,0.2)',
    },
    modelLabel: { fontSize: 12, color: '#9ca3af' },
    modelName: { fontSize: 12, fontWeight: '500', color: '#111827' },
    modelProvider: { fontSize: 12, color: '#9ca3af' },

    // Empty row
    emptyRow: { paddingHorizontal: 12, paddingVertical: 16, alignItems: 'center' },
    emptyRowText: { fontSize: 12, color: 'rgba(156,163,175,0.6)' },
})
