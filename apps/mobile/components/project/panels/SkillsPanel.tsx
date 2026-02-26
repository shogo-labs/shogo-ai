import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { Zap, RefreshCw, BookOpen, Download, Check, Trash2, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface Skill {
  file: string
  name: string
  description: string
  trigger: string
}

interface BundledSkill {
  name: string
  description: string
  trigger: string
  tools: string[]
}

interface SkillsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function SkillsPanel({ projectId, agentUrl, visible }: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [bundledSkills, setBundledSkills] = useState<BundledSkill[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    if (!agentUrl) return
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
        })),
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

  const handleInstall = useCallback(
    async (skillName: string) => {
      if (!agentUrl) return
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
        const res = await fetch(
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

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Header */}
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Zap size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Skills</Text>
        <Text className="text-xs text-muted-foreground">{skills.length} installed</Text>

        <View className="ml-auto flex-row items-center gap-1">
          <Pressable
            onPress={() => setShowLibrary(!showLibrary)}
            className={cn(
              'flex-row items-center gap-1 px-2 py-1 rounded-md',
              showLibrary ? 'bg-primary' : 'active:bg-muted',
            )}
          >
            <BookOpen size={12} className={showLibrary ? 'text-primary-foreground' : 'text-muted-foreground'} />
            <Text
              className={cn(
                'text-xs',
                showLibrary ? 'text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              Library
            </Text>
          </Pressable>
          <Pressable onPress={loadSkills} className="p-1 rounded-md active:bg-muted">
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
              availableBundled.map((skill) => (
                <View key={skill.name} className="border border-border rounded-lg p-3">
                  <View className="flex-row items-start justify-between gap-2">
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-foreground">{skill.name}</Text>
                      {skill.description ? (
                        <Text className="text-xs text-muted-foreground mt-0.5">
                          {skill.description}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      onPress={() => handleInstall(skill.name)}
                      disabled={installing === skill.name}
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
                    <View className="flex-row flex-wrap gap-1 mt-2">
                      {skill.trigger.split('|').map((t, i) => (
                        <View key={i} className="px-1.5 py-0.5 bg-primary/10 rounded">
                          <Text className="text-primary text-[10px]">{t.trim()}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  {skill.tools?.length > 0 ? (
                    <View className="flex-row flex-wrap gap-1 mt-1.5">
                      {skill.tools.map((tool) => (
                        <View key={tool} className="px-1.5 py-0.5 bg-muted rounded">
                          <Text className="text-muted-foreground text-[10px]">{tool}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              ))
            )}

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
        ) : skills.length === 0 ? (
          <View className="items-center py-12">
            <Zap size={32} className="text-muted-foreground mb-3" />
            <Text className="text-sm text-muted-foreground mb-1">No skills installed</Text>
            <Text className="text-xs text-muted-foreground mb-3">
              Skills teach your agent specific behaviors triggered by keywords.
            </Text>
            <Pressable
              onPress={() => setShowLibrary(true)}
              className="flex-row items-center gap-1 px-3 py-1.5 rounded-md bg-primary active:bg-primary/80"
            >
              <BookOpen size={12} className="text-primary-foreground" />
              <Text className="text-xs text-primary-foreground">Browse Skill Library</Text>
            </Pressable>
          </View>
        ) : (
          <View className="gap-3">
            {skills.map((skill) => (
              <View key={skill.file} className="border border-border rounded-lg p-3">
                <View className="flex-row items-start justify-between gap-2">
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-foreground">{skill.name}</Text>
                    {skill.description ? (
                      <Text className="text-xs text-muted-foreground mt-0.5">
                        {skill.description}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => handleRemove(skill.name)}
                    disabled={removing === skill.name}
                    className="p-1 rounded-md active:bg-destructive/10"
                    style={removing === skill.name ? { opacity: 0.5 } : undefined}
                  >
                    <Trash2 size={14} className="text-muted-foreground" />
                  </Pressable>
                </View>

                {skill.trigger ? (
                  <View className="flex-row flex-wrap gap-1 mt-2">
                    {skill.trigger.split('|').map((t, i) => (
                      <View key={i} className="px-1.5 py-0.5 bg-primary/10 rounded">
                        <Text className="text-primary text-[10px]">{t.trim()}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}

            {availableBundled.length > 0 && (
              <View className="pt-2 border-t border-border">
                <Pressable
                  onPress={() => setShowLibrary(true)}
                  className="flex-row items-center justify-center gap-1 py-2"
                >
                  <Plus size={12} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    {availableBundled.length} more skills available in library
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
