// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, TextInput } from 'react-native'
import { Zap, RefreshCw, BookOpen, Download, Check, Trash2, Plus, ChevronDown, ChevronRight, Search, Globe, FileCode } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { agentFetch } from '../../../lib/agent-fetch'

interface Skill {
  name: string
  description: string
  trigger: string
}

interface SkillScript {
  filename: string
  runtime: string
  size: number
}

interface BundledSkill {
  name: string
  description: string
  trigger: string
  tools: string[]
  content?: string
}

interface RegistrySkill {
  name: string
  description: string
  source: string
  sourceDescription: string
  dirName: string
}

interface SkillsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function SkillsPanel({ projectId, agentUrl, visible }: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [bundledSkills, setBundledSkills] = useState<BundledSkill[]>([])
  const [registrySkills, setRegistrySkills] = useState<RegistrySkill[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<Record<string, string>>({})
  const [skillScripts, setSkillScripts] = useState<Record<string, SkillScript[]>>({})
  const [loadingContent, setLoadingContent] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [libraryTab, setLibraryTab] = useState<'bundled' | 'community'>('community')

  const toggleSkillDetail = useCallback(
    async (skillName: string) => {
      if (expandedSkill === skillName) {
        setExpandedSkill(null)
        return
      }
      setExpandedSkill(skillName)
      if (skillContent[skillName] || !agentUrl) return
      setLoadingContent(skillName)
      try {
        const [contentRes, scriptsRes] = await Promise.all([
          agentFetch(`${agentUrl}/agent/skills/${encodeURIComponent(skillName)}`),
          agentFetch(`${agentUrl}/agent/skills/${encodeURIComponent(skillName)}/scripts`).catch(() => null),
        ])
        if (contentRes.ok) {
          const data = await contentRes.json()
          setSkillContent((prev) => ({ ...prev, [skillName]: data.content }))
        }
        if (scriptsRes?.ok) {
          const data = await scriptsRes.json()
          if (data.scripts?.length > 0) {
            setSkillScripts((prev) => ({ ...prev, [skillName]: data.scripts }))
          }
        }
      } catch {
        // silently fail — card just won't show content
      } finally {
        setLoadingContent(null)
      }
    },
    [agentUrl, expandedSkill, skillContent],
  )

  const loadSkills = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const [statusRes, bundledRes, registryRes] = await Promise.all([
        agentFetch(`${agentUrl}/agent/status`),
        agentFetch(`${agentUrl}/agent/bundled-skills`),
        agentFetch(`${agentUrl}/agent/skill-registry`).catch(() => null),
      ])
      if (!statusRes.ok) throw new Error('Agent not reachable')
      const status = await statusRes.json()
      setSkills(
        (status.skills || []).map((s: any) => ({
          name: s.name,
          description: s.description || '',
          trigger: s.trigger || '',
        })),
      )
      if (bundledRes.ok) {
        const bundledData = await bundledRes.json()
        setBundledSkills(bundledData.skills || [])
      }
      if (registryRes?.ok) {
        const registryData = await registryRes.json()
        setRegistrySkills(registryData.skills || [])
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

  const handleInstall = useCallback(
    async (skillName: string) => {
      if (!agentUrl) return
      setInstalling(skillName)
      try {
        const res = await agentFetch(`${agentUrl}/agent/bundled-skills/install`, {
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
        setError(err.message)
      } finally {
        setInstalling(null)
      }
    },
    [agentUrl, loadSkills],
  )

  const handleRegistryInstall = useCallback(
    async (skill: RegistrySkill) => {
      if (!agentUrl) return
      const key = `${skill.source}:${skill.dirName}`
      setInstalling(key)
      try {
        const res = await agentFetch(`${agentUrl}/agent/skill-registry/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: skill.name, source: skill.source, dirName: skill.dirName }),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to install skill')
        }
        await loadSkills()
      } catch (err: any) {
        setError(err.message)
      } finally {
        setInstalling(null)
      }
    },
    [agentUrl, loadSkills],
  )

  const handleRemove = useCallback(
    async (skillName: string) => {
      if (!agentUrl) return
      setRemoving(skillName)
      try {
        const res = await agentFetch(
          `${agentUrl}/agent/skills/${encodeURIComponent(skillName)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to remove skill')
        }
        await loadSkills()
      } catch (err: any) {
        setError(err.message)
      } finally {
        setRemoving(null)
      }
    },
    [agentUrl, loadSkills],
  )

  if (!visible) return null

  const installedNames = new Set(skills.map((s) => s.name))
  const availableBundled = bundledSkills.filter((s) => !installedNames.has(s.name))

  const filteredRegistrySkills = useMemo(() => {
    const available = registrySkills.filter((s) => !installedNames.has(s.name))
    if (!searchQuery.trim()) return available.slice(0, 50)
    const q = searchQuery.toLowerCase()
    return available
      .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.source.toLowerCase().includes(q))
      .slice(0, 50)
  }, [registrySkills, installedNames, searchQuery])

  const registrySourceCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of registrySkills) {
      counts[s.source] = (counts[s.source] || 0) + 1
    }
    return counts
  }, [registrySkills])

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Zap size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Skills</Text>
        <Text className="text-xs text-muted-foreground">{skills.length} installed</Text>
        {registrySkills.length > 0 && (
          <Text className="text-xs text-muted-foreground">· {registrySkills.length} available</Text>
        )}
        <View className="ml-auto flex-row items-center gap-1">
          <Pressable
            onPress={() => { setShowLibrary(!showLibrary); setSearchQuery('') }}
            accessibilityRole="button"
            accessibilityLabel={showLibrary ? 'Close skill library' : 'Open skill library'}
            accessibilityState={{ expanded: showLibrary }}
            className={cn(
              'flex-row items-center gap-1 px-2 py-1 rounded-md',
              showLibrary ? 'bg-primary' : 'active:bg-muted',
            )}
          >
            <BookOpen size={12} className={showLibrary ? 'text-primary-foreground' : 'text-muted-foreground'} />
            <Text className={cn('text-xs', showLibrary ? 'text-primary-foreground' : 'text-muted-foreground')}>
              Library
            </Text>
          </Pressable>
          <Pressable
            onPress={loadSkills}
            accessibilityRole="button"
            accessibilityLabel="Refresh skills"
            className="p-1 rounded-md active:bg-muted"
          >
            <RefreshCw size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {error && (
        <View className="px-4 py-2 bg-destructive/10">
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
            <Text className="text-sm text-muted-foreground mt-2">Loading skills...</Text>
          </View>
        ) : showLibrary ? (
          <View className="gap-3">
            {/* Library tabs */}
            <View className="flex-row gap-1 bg-muted/50 rounded-lg p-1" accessibilityRole="tablist">
              <Pressable
                onPress={() => { setLibraryTab('community'); setSearchQuery('') }}
                accessibilityRole="tab"
                accessibilityLabel={`Community skills, ${registrySkills.length} available`}
                accessibilityState={{ selected: libraryTab === 'community' }}
                className={cn(
                  'flex-1 flex-row items-center justify-center gap-1.5 py-1.5 rounded-md',
                  libraryTab === 'community' ? 'bg-background shadow-sm' : '',
                )}
              >
                <Globe size={12} className={libraryTab === 'community' ? 'text-foreground' : 'text-muted-foreground'} />
                <Text className={cn('text-xs font-medium', libraryTab === 'community' ? 'text-foreground' : 'text-muted-foreground')}>
                  Community ({registrySkills.length})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => { setLibraryTab('bundled'); setSearchQuery('') }}
                accessibilityRole="tab"
                accessibilityLabel={`Built-in skills, ${bundledSkills.length} available`}
                accessibilityState={{ selected: libraryTab === 'bundled' }}
                className={cn(
                  'flex-1 flex-row items-center justify-center gap-1.5 py-1.5 rounded-md',
                  libraryTab === 'bundled' ? 'bg-background shadow-sm' : '',
                )}
              >
                <BookOpen size={12} className={libraryTab === 'bundled' ? 'text-foreground' : 'text-muted-foreground'} />
                <Text className={cn('text-xs font-medium', libraryTab === 'bundled' ? 'text-foreground' : 'text-muted-foreground')}>
                  Built-in ({bundledSkills.length})
                </Text>
              </Pressable>
            </View>

            {/* Community skills tab */}
            {libraryTab === 'community' ? (
              <View className="gap-3">
                <View className="flex-row items-center gap-2 bg-muted/30 rounded-lg px-3 py-2">
                  <Search size={14} className="text-muted-foreground" />
                  <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={`Search ${registrySkills.length} community skills...`}
                    placeholderTextColor="#888"
                    className="flex-1 text-sm text-foreground"
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="Search community skills"
                  />
                </View>

                {Object.keys(registrySourceCounts).length > 0 && !searchQuery && (
                  <View className="flex-row flex-wrap gap-1">
                    {Object.entries(registrySourceCounts).map(([source, count]) => (
                      <Pressable
                        key={source}
                        onPress={() => setSearchQuery(source)}
                        className="px-2 py-1 bg-muted rounded-md"
                      >
                        <Text className="text-[10px] text-muted-foreground">{source} ({count})</Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                {filteredRegistrySkills.length === 0 ? (
                  <View className="items-center py-8">
                    <Search size={32} className="text-muted-foreground mb-3" />
                    <Text className="text-sm text-muted-foreground">
                      {searchQuery ? 'No skills match your search' : 'No community skills available'}
                    </Text>
                  </View>
                ) : (
                  filteredRegistrySkills.map((skill) => {
                    const key = `${skill.source}:${skill.dirName}`
                    return (
                      <View key={key} className="border border-border rounded-lg p-3">
                        <View className="flex-row items-start justify-between gap-2">
                          <View className="flex-1">
                            <Text className="text-sm font-medium text-foreground">{skill.name}</Text>
                            {skill.description ? (
                              <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={2}>
                                {skill.description}
                              </Text>
                            ) : null}
                            <View className="flex-row items-center gap-1 mt-1">
                              <Globe size={10} className="text-muted-foreground" />
                              <Text className="text-[10px] text-muted-foreground">{skill.source}</Text>
                            </View>
                          </View>
                          <Pressable
                            onPress={() => handleRegistryInstall(skill)}
                            disabled={installing === key}
                            accessibilityRole="button"
                            accessibilityLabel={`Install ${skill.name} skill`}
                            accessibilityState={{ busy: installing === key }}
                            className={cn(
                              'flex-row items-center gap-1 px-2 py-1 rounded-md',
                              installing === key ? 'bg-muted' : 'bg-primary active:bg-primary/80',
                            )}
                          >
                            <Download
                              size={12}
                              className={installing === key ? 'text-muted-foreground' : 'text-primary-foreground'}
                            />
                            <Text
                              className={cn(
                                'text-xs',
                                installing === key ? 'text-muted-foreground' : 'text-primary-foreground',
                              )}
                            >
                              {installing === key ? 'Installing...' : 'Install'}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    )
                  })
                )}

                {filteredRegistrySkills.length >= 50 && (
                  <Text className="text-xs text-muted-foreground text-center">
                    Showing first 50 results. Refine your search to find more.
                  </Text>
                )}
              </View>
            ) : (
              /* Bundled skills tab */
              <View className="gap-3">
                <Text className="text-xs text-muted-foreground">
                  Pre-built skills you can add to your agent with one click.
                </Text>

                {availableBundled.length === 0 && bundledSkills.length > 0 ? (
                  <View className="items-center py-8">
                    <Check size={32} className="text-emerald-500 mb-3" />
                    <Text className="text-sm text-muted-foreground">All bundled skills are installed!</Text>
                  </View>
                ) : availableBundled.length === 0 ? (
                  <View className="items-center py-8">
                    <BookOpen size={32} className="text-muted-foreground mb-3" />
                    <Text className="text-sm text-muted-foreground">No bundled skills available</Text>
                  </View>
                ) : (
                  availableBundled.map((skill) => {
                    const isExpanded = expandedSkill === `bundled:${skill.name}`
                    return (
                      <View key={skill.name} className="border border-border rounded-lg">
                        <Pressable
                          onPress={() =>
                            setExpandedSkill(
                              isExpanded ? null : `bundled:${skill.name}`,
                            )
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`${skill.name} skill details`}
                          accessibilityState={{ expanded: isExpanded }}
                          className="p-3 active:bg-muted/50"
                        >
                          <View className="flex-row items-start justify-between gap-2">
                            <View className="flex-row items-center gap-1.5 flex-1">
                              {isExpanded ? (
                                <ChevronDown size={14} className="text-muted-foreground" />
                              ) : (
                                <ChevronRight size={14} className="text-muted-foreground" />
                              )}
                              <View className="flex-1">
                                <Text className="text-sm font-medium text-foreground">{skill.name}</Text>
                                {skill.description ? (
                                  <Text className="text-xs text-muted-foreground mt-0.5">
                                    {skill.description}
                                  </Text>
                                ) : null}
                              </View>
                            </View>
                            <Pressable
                              onPress={(e) => {
                                e.stopPropagation()
                                handleInstall(skill.name)
                              }}
                              disabled={installing === skill.name}
                              accessibilityRole="button"
                              accessibilityLabel={`Install ${skill.name} skill`}
                              accessibilityState={{ busy: installing === skill.name }}
                              className={cn(
                                'flex-row items-center gap-1 px-2 py-1 rounded-md',
                                installing === skill.name ? 'bg-muted' : 'bg-primary active:bg-primary/80',
                              )}
                            >
                              <Download
                                size={12}
                                className={installing === skill.name ? 'text-muted-foreground' : 'text-primary-foreground'}
                              />
                              <Text
                                className={cn(
                                  'text-xs',
                                  installing === skill.name ? 'text-muted-foreground' : 'text-primary-foreground',
                                )}
                              >
                                {installing === skill.name ? 'Installing...' : 'Install'}
                              </Text>
                            </Pressable>
                          </View>

                          {skill.trigger ? (
                            <View className="flex-row flex-wrap gap-1 mt-2 ml-5">
                              {skill.trigger.split('|').map((t, i) => (
                                <View key={i} className="px-1.5 py-0.5 bg-primary/10 rounded">
                                  <Text className="text-primary text-[10px]">{t.trim()}</Text>
                                </View>
                              ))}
                            </View>
                          ) : null}

                          {skill.tools?.length > 0 ? (
                            <View className="flex-row flex-wrap gap-1 mt-1.5 ml-5">
                              {skill.tools.map((tool) => (
                                <View key={tool} className="px-1.5 py-0.5 bg-muted rounded">
                                  <Text className="text-muted-foreground text-[10px]">{tool}</Text>
                                </View>
                              ))}
                            </View>
                          ) : null}
                        </Pressable>

                        {isExpanded && skill.content ? (
                          <View className="px-3 pb-3 border-t border-border">
                            <ScrollView
                              className="mt-2 bg-muted/30 rounded-md p-3"
                              style={{ maxHeight: 300 }}
                            >
                              <Text className="text-xs text-foreground font-mono" selectable>
                                {skill.content}
                              </Text>
                            </ScrollView>
                          </View>
                        ) : null}
                      </View>
                    )
                  }))
                }

                {bundledSkills.filter((s) => installedNames.has(s.name)).length > 0 && (
                  <View className="mt-4">
                    <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                      Already Installed
                    </Text>
                    {bundledSkills
                      .filter((s) => installedNames.has(s.name))
                      .map((skill) => (
                        <View
                          key={skill.name}
                          className="border border-dashed border-border rounded-lg p-3 mb-2 opacity-60"
                        >
                          <View className="flex-row items-center gap-2">
                            <Check size={14} className="text-emerald-500" />
                            <Text className="text-sm font-medium text-foreground">{skill.name}</Text>
                          </View>
                        </View>
                      ))}
                  </View>
                )}
              </View>
            )}
          </View>
        ) : skills.length === 0 ? (
          <View className="items-center py-12">
            <Zap size={32} className="text-muted-foreground mb-3" />
            <Text className="text-sm text-muted-foreground mb-1">No skills installed</Text>
            <Text className="text-xs text-muted-foreground mb-3">
              Skills teach your agent specific behaviors triggered by keywords.
            </Text>
            <Pressable
              onPress={() => setShowLibrary(true)}
              accessibilityRole="button"
              accessibilityLabel="Browse skill library"
              className="flex-row items-center gap-1 px-3 py-1.5 rounded-md bg-primary active:bg-primary/80"
            >
              <BookOpen size={12} className="text-primary-foreground" />
              <Text className="text-xs text-primary-foreground">Browse Skill Library</Text>
            </Pressable>
          </View>
        ) : (
          <View className="gap-3">
            {skills.map((skill) => {
              const isExpanded = expandedSkill === skill.name
              const content = skillContent[skill.name]
              const isLoadingThis = loadingContent === skill.name

              return (
                <View key={skill.name} className="border border-border rounded-lg">
                  <Pressable
                    onPress={() => toggleSkillDetail(skill.name)}
                    accessibilityRole="button"
                    accessibilityLabel={`${skill.name} skill details`}
                    accessibilityState={{ expanded: isExpanded }}
                    className="p-3 active:bg-muted/50"
                  >
                    <View className="flex-row items-start justify-between gap-2">
                      <View className="flex-row items-center gap-1.5 flex-1">
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-muted-foreground" />
                        ) : (
                          <ChevronRight size={14} className="text-muted-foreground" />
                        )}
                        <View className="flex-1">
                          <Text className="text-sm font-medium text-foreground">{skill.name}</Text>
                          {skill.description ? (
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              {skill.description}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                      <Pressable
                        onPress={(e) => {
                          e.stopPropagation()
                          handleRemove(skill.name)
                        }}
                        disabled={removing === skill.name}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${skill.name} skill`}
                        accessibilityState={{ busy: removing === skill.name }}
                        className="p-1 rounded-md active:bg-destructive/10"
                        style={removing === skill.name ? { opacity: 0.5 } : undefined}
                      >
                        <Trash2 size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>

                    {skill.trigger ? (
                      <View className="flex-row flex-wrap gap-1 mt-2 ml-5">
                        {skill.trigger.split('|').map((t, i) => (
                          <View key={i} className="px-1.5 py-0.5 bg-primary/10 rounded">
                            <Text className="text-primary text-[10px]">{t.trim()}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </Pressable>

                  {isExpanded && (
                    <View className="px-3 pb-3 border-t border-border">
                      {isLoadingThis ? (
                        <View className="items-center py-4">
                          <ActivityIndicator size="small" />
                        </View>
                      ) : content ? (
                        <>
                          <ScrollView
                            className="mt-2 bg-muted/30 rounded-md p-3"
                            style={{ maxHeight: 300 }}
                          >
                            <Text className="text-xs text-foreground font-mono" selectable>
                              {content}
                            </Text>
                          </ScrollView>
                          {skillScripts[skill.name]?.length > 0 && (
                            <View className="mt-2">
                              <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
                                Scripts
                              </Text>
                              <View className="gap-1">
                                {skillScripts[skill.name].map((s) => (
                                  <View key={s.filename} className="flex-row items-center gap-2 px-2 py-1 bg-muted/30 rounded">
                                    <FileCode size={10} className="text-muted-foreground" />
                                    <Text className="text-xs text-foreground flex-1">{s.filename}</Text>
                                    <Text className="text-[10px] text-muted-foreground">{s.runtime}</Text>
                                    <Text className="text-[10px] text-muted-foreground">{(s.size / 1024).toFixed(1)}KB</Text>
                                  </View>
                                ))}
                              </View>
                            </View>
                          )}
                        </>
                      ) : (
                        <Text className="text-xs text-muted-foreground mt-2">
                          Could not load skill content.
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              )
            })}

            {(availableBundled.length > 0 || registrySkills.length > 0) && (
              <View className="pt-2 border-t border-border">
                <Pressable
                  onPress={() => setShowLibrary(true)}
                  className="flex-row items-center justify-center gap-1 py-2"
                >
                  <Plus size={12} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    {availableBundled.length + registrySkills.length} more skills available in library
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  )
}
