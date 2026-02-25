/**
 * AgentSkillsPanel (React Native)
 *
 * Browse, create, and manage agent skills.
 * Includes native built-in badge (Shield icon) and prevents removing native skills.
 *
 * Port of: apps/web/src/components/app/project/agent/AgentSkillsPanel.tsx
 * Commit: 2720f5f — native built-in skills support
 */

import React, { useState, useEffect, useCallback } from 'react'
import {
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
    Alert,
    StyleSheet,
} from 'react-native'
import {
    Zap,
    Plus,
    RefreshCw,
    BookOpen,
    Download,
    Check,
    Trash2,
    Shield,
} from 'lucide-react-native'

interface Skill {
    file: string
    name: string
    description: string
    trigger: string
    native: boolean
}

interface BundledSkill {
    name: string
    description: string
    trigger: string
    tools: string[]
    native: boolean
}

interface AgentSkillsPanelProps {
    agentUrl: string
    visible?: boolean
}

export default function AgentSkillsPanel({ agentUrl, visible = true }: AgentSkillsPanelProps) {
    const [skills, setSkills] = useState<Skill[]>([])
    const [bundledSkills, setBundledSkills] = useState<BundledSkill[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showLibrary, setShowLibrary] = useState(false)
    const [installing, setInstalling] = useState<string | null>(null)
    const [removing, setRemoving] = useState<string | null>(null)

    const loadSkills = useCallback(async () => {
        setIsLoading(true)
        setError(null)
        try {
            const [statusRes, bundledRes] = await Promise.all([
                fetch(`${agentUrl}/agent/status`),
                fetch(`${agentUrl}/agent/bundled-skills`),
            ])

            if (!statusRes.ok) throw new Error('Agent not reachable')
            const status = await statusRes.json()

            setSkills(
                (status.skills || []).map((s: any) => ({
                    file: `${s.name}.md`,
                    name: s.name,
                    description: s.description || '',
                    trigger: s.trigger || '',
                    native: s.native ?? false,
                }))
            )

            if (bundledRes.ok) {
                const bundledData = await bundledRes.json()
                setBundledSkills(bundledData.skills || [])
            }
        } catch (err: any) {
            setError(err.message)
        } finally {
            setIsLoading(false)
        }
    }, [agentUrl])

    useEffect(() => {
        if (visible) loadSkills()
    }, [visible, loadSkills])

    const handleInstall = useCallback(async (skillName: string) => {
        setInstalling(skillName)
        try {
            const res = await fetch(`${agentUrl}/agent/bundled-skills/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: skillName }),
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || 'Failed to install skill')
            }
            await loadSkills()
        } catch (err: any) {
            Alert.alert('Error', err.message)
        } finally {
            setInstalling(null)
        }
    }, [agentUrl, loadSkills])

    const handleRemove = useCallback(async (skillName: string) => {
        setRemoving(skillName)
        try {
            const res = await fetch(`${agentUrl}/agent/skills/${encodeURIComponent(skillName)}`, {
                method: 'DELETE',
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || 'Failed to remove skill')
            }
            await loadSkills()
        } catch (err: any) {
            Alert.alert('Error', err.message)
        } finally {
            setRemoving(null)
        }
    }, [agentUrl, loadSkills])

    const installedNames = new Set(skills.map((s) => s.name))
    const availableBundled = bundledSkills.filter((s) => !installedNames.has(s.name))

    if (!visible) return null

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Zap size={16} color="#9ca3af" strokeWidth={2} />
                    <Text style={styles.headerTitle}>Skills</Text>
                    <Text style={styles.headerCount}>{skills.length} active</Text>
                </View>
                <View style={styles.headerRight}>
                    <TouchableOpacity
                        style={[styles.libraryBtn, showLibrary && styles.libraryBtnActive]}
                        onPress={() => setShowLibrary(!showLibrary)}
                    >
                        <BookOpen size={12} color={showLibrary ? '#fff' : '#9ca3af'} strokeWidth={2} />
                        <Text style={[styles.libraryBtnText, showLibrary && styles.libraryBtnTextActive]}>Library</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.refreshBtn} onPress={loadSkills}>
                        <RefreshCw size={14} color="#9ca3af" strokeWidth={2} />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Error */}
            {error ? (
                <View style={styles.errorBar}>
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            ) : null}

            {/* Content */}
            <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
                {isLoading ? (
                    <View style={styles.emptyCenter}>
                        <ActivityIndicator size="small" color="#9ca3af" />
                        <Text style={styles.emptyText}>Loading skills...</Text>
                    </View>
                ) : showLibrary ? (
                    /* ─── Library View ─── */
                    <View style={styles.libraryContainer}>
                        <Text style={styles.libraryHint}>
                            Pre-built skills you can add to your agent with one click.
                        </Text>

                        {availableBundled.length === 0 && bundledSkills.length > 0 ? (
                            <View style={styles.emptyCenter}>
                                <Check size={32} color="#22c55e" strokeWidth={2} />
                                <Text style={styles.emptyText}>All bundled skills are installed!</Text>
                            </View>
                        ) : availableBundled.length === 0 ? (
                            <View style={styles.emptyCenter}>
                                <BookOpen size={32} color="rgba(156,163,175,0.5)" strokeWidth={2} />
                                <Text style={styles.emptyText}>No bundled skills available</Text>
                            </View>
                        ) : (
                            availableBundled.map((skill) => (
                                <View key={skill.name} style={styles.skillCard}>
                                    <View style={styles.skillRow}>
                                        <View style={styles.skillInfo}>
                                            <Text style={styles.skillName}>{skill.name}</Text>
                                            {skill.description ? (
                                                <Text style={styles.skillDesc}>{skill.description}</Text>
                                            ) : null}
                                        </View>
                                        <TouchableOpacity
                                            style={[styles.installBtn, installing === skill.name && styles.installBtnDisabled]}
                                            onPress={() => handleInstall(skill.name)}
                                            disabled={installing === skill.name}
                                        >
                                            <Download size={12} color="#fff" strokeWidth={2} />
                                            <Text style={styles.installBtnText}>
                                                {installing === skill.name ? 'Installing...' : 'Install'}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                    {skill.trigger ? (
                                        <View style={styles.tagRow}>
                                            {skill.trigger.split('|').map((t, i) => (
                                                <View key={i} style={styles.triggerTag}>
                                                    <Text style={styles.triggerTagText}>{t.trim()}</Text>
                                                </View>
                                            ))}
                                        </View>
                                    ) : null}
                                    {skill.tools && skill.tools.length > 0 ? (
                                        <View style={styles.tagRow}>
                                            {skill.tools.map((tool) => (
                                                <View key={tool} style={styles.toolTag}>
                                                    <Text style={styles.toolTagText}>{tool}</Text>
                                                </View>
                                            ))}
                                        </View>
                                    ) : null}
                                </View>
                            ))
                        )}

                        {/* Already Active section */}
                        {bundledSkills.filter((s) => installedNames.has(s.name)).length > 0 ? (
                            <View style={styles.alreadyActive}>
                                <Text style={styles.alreadyActiveTitle}>ALREADY ACTIVE</Text>
                                {bundledSkills
                                    .filter((s) => installedNames.has(s.name))
                                    .map((skill) => (
                                        <View key={skill.name} style={styles.alreadyActiveCard}>
                                            <Check size={14} color="#22c55e" strokeWidth={2} />
                                            <Text style={styles.skillName}>{skill.name}</Text>
                                            {/* ── Commit 2720f5f: Built-in badge ── */}
                                            {skill.native ? (
                                                <View style={styles.nativeBadge}>
                                                    <Shield size={10} color="#2563eb" strokeWidth={2} />
                                                    <Text style={styles.nativeBadgeText}>Built-in</Text>
                                                </View>
                                            ) : null}
                                        </View>
                                    ))}
                            </View>
                        ) : null}
                    </View>
                ) : skills.length === 0 ? (
                    /* ─── Empty State ─── */
                    <View style={styles.emptyCenter}>
                        <Zap size={32} color="rgba(156,163,175,0.5)" strokeWidth={2} />
                        <Text style={styles.emptyText}>No skills installed</Text>
                        <Text style={styles.emptyHint}>Skills teach your agent specific behaviors triggered by keywords.</Text>
                        <TouchableOpacity style={styles.browseBtn} onPress={() => setShowLibrary(true)}>
                            <BookOpen size={12} color="#fff" strokeWidth={2} />
                            <Text style={styles.browseBtnText}>Browse Skill Library</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    /* ─── Installed Skills List ─── */
                    <View style={styles.installedList}>
                        {skills.map((skill) => (
                            <View key={skill.file} style={styles.skillCard}>
                                <View style={styles.skillRow}>
                                    <View style={styles.skillInfo}>
                                        <View style={styles.skillNameRow}>
                                            <Text style={styles.skillName}>{skill.name}</Text>
                                            {/* ── Commit 2720f5f: Built-in badge ── */}
                                            {skill.native ? (
                                                <View style={styles.nativeBadge}>
                                                    <Shield size={10} color="#2563eb" strokeWidth={2} />
                                                    <Text style={styles.nativeBadgeText}>Built-in</Text>
                                                </View>
                                            ) : null}
                                        </View>
                                        {skill.description ? (
                                            <Text style={styles.skillDesc}>{skill.description}</Text>
                                        ) : null}
                                    </View>
                                    {/* ── Commit 2720f5f: hide trash for native skills ── */}
                                    {!skill.native ? (
                                        <TouchableOpacity
                                            style={styles.removeBtn}
                                            onPress={() => handleRemove(skill.name)}
                                            disabled={removing === skill.name}
                                        >
                                            <Trash2 size={14} color={removing === skill.name ? '#9ca3af' : '#ef4444'} strokeWidth={2} />
                                        </TouchableOpacity>
                                    ) : null}
                                </View>
                                {skill.trigger ? (
                                    <View style={styles.tagRow}>
                                        {skill.trigger.split('|').map((t, i) => (
                                            <View key={i} style={styles.triggerTag}>
                                                <Text style={styles.triggerTagText}>{t.trim()}</Text>
                                            </View>
                                        ))}
                                    </View>
                                ) : null}
                            </View>
                        ))}

                        {availableBundled.length > 0 ? (
                            <TouchableOpacity style={styles.moreSkillsBtn} onPress={() => setShowLibrary(true)}>
                                <Plus size={12} color="#9ca3af" strokeWidth={2} />
                                <Text style={styles.moreSkillsText}>
                                    {availableBundled.length} more skills available in library
                                </Text>
                            </TouchableOpacity>
                        ) : null}
                    </View>
                )}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    // Header
    header: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    headerTitle: { fontSize: 14, fontWeight: '500', color: '#111827' },
    headerCount: { fontSize: 12, color: '#9ca3af' },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    libraryBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
    },
    libraryBtnActive: { backgroundColor: '#3b82f6' },
    libraryBtnText: { fontSize: 12, color: '#9ca3af' },
    libraryBtnTextActive: { color: '#fff' },
    refreshBtn: { padding: 4, borderRadius: 6 },

    // Error
    errorBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(239,68,68,0.1)' },
    errorText: { fontSize: 12, color: '#ef4444' },

    // Content
    content: { flex: 1 },
    contentInner: { padding: 16 },

    // Empty state
    emptyCenter: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
    emptyText: { fontSize: 14, color: '#9ca3af' },
    emptyHint: { fontSize: 12, color: 'rgba(156,163,175,0.7)', textAlign: 'center' },
    browseBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: '#3b82f6', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6,
    },
    browseBtnText: { fontSize: 12, color: '#fff' },

    // Library
    libraryContainer: { gap: 12 },
    libraryHint: { fontSize: 12, color: '#9ca3af' },
    alreadyActive: { marginTop: 16, gap: 8 },
    alreadyActiveTitle: { fontSize: 10, fontWeight: '500', color: '#9ca3af', letterSpacing: 1 },
    alreadyActiveCard: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        borderWidth: 1, borderColor: '#e5e7eb', borderStyle: 'dashed',
        borderRadius: 10, padding: 12, opacity: 0.6,
    },

    // Skill card
    skillCard: {
        borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12, marginBottom: 12,
    },
    skillRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
    skillInfo: { flex: 1 },
    skillNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    skillName: { fontSize: 14, fontWeight: '500', color: '#111827' },
    skillDesc: { fontSize: 12, color: '#9ca3af', marginTop: 2 },

    // ── Commit 2720f5f: native badge ──
    nativeBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 3,
        backgroundColor: 'rgba(59,130,246,0.1)',
        paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    },
    nativeBadgeText: { fontSize: 10, fontWeight: '500', color: '#2563eb' },

    // Buttons
    installBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: '#3b82f6', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
    },
    installBtnDisabled: { backgroundColor: '#d1d5db' },
    installBtnText: { fontSize: 12, color: '#fff' },
    removeBtn: { padding: 4, borderRadius: 6 },

    // Tags
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 },
    triggerTag: {
        backgroundColor: 'rgba(59,130,246,0.1)',
        paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    },
    triggerTagText: { fontSize: 10, color: '#3b82f6' },
    toolTag: {
        backgroundColor: '#f3f4f6',
        paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    },
    toolTagText: { fontSize: 10, color: '#9ca3af' },

    // Installed list
    installedList: { gap: 0 },
    moreSkillsBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e5e7eb', marginTop: 4,
    },
    moreSkillsText: { fontSize: 12, color: '#9ca3af' },
})
