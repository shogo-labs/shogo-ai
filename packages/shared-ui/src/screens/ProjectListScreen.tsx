/**
 * Shared ProjectListScreen (Universal React Native + NativeWind)
 *
 * Displays a list of projects with search and optional create agent support.
 * Used by both web and mobile apps for the home/project list view.
 */

import React, { useState } from 'react'
import { View, Text, FlatList, Modal, Pressable, ActivityIndicator } from 'react-native'
import { Button } from '../primitives/Button'
import { Card, CardContent } from '../primitives/Card'
import { Input } from '../primitives/Input'
import { Badge } from '../primitives/Badge'
import { Skeleton } from '../primitives/Skeleton'

export interface ProjectItem {
  id: string
  name: string
  description?: string | null
  updatedAt: string | Date
  type?: string
  status?: string
}

export interface ProjectListScreenProps {
  projects: ProjectItem[]
  isLoading: boolean
  userName?: string
  onProjectPress: (id: string) => void
  onCreateProject?: (name: string) => Promise<void>
  searchQuery?: string
  onSearchChange?: (query: string) => void
}

export function ProjectListScreen({
  projects,
  isLoading,
  userName,
  onProjectPress,
  onCreateProject,
  searchQuery = '',
  onSearchChange,
}: ProjectListScreenProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const filtered = searchQuery
    ? projects.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : projects

  const handleCreate = async () => {
    if (!newName.trim() || !onCreateProject) return
    setCreating(true)
    setCreateError(null)
    try {
      await onCreateProject(newName.trim())
      setNewName('')
      setShowCreate(false)
    } catch (e: any) {
      setCreateError(e.message || 'Failed to create agent')
    } finally {
      setCreating(false)
    }
  }

  const renderProjectCard = ({ item }: { item: ProjectItem }) => (
    <Card className="mb-3">
      <CardContent className="p-4">
        <Pressable onPress={() => onProjectPress(item.id)} className="w-full">
          <View className="flex-row items-start justify-between">
            <Text className="text-foreground font-semibold text-base flex-1">{item.name}</Text>
            <View className="flex-row gap-1.5">
              {item.type ? (
                <Badge variant="secondary">{item.type}</Badge>
              ) : null}
              {item.status ? (
                <Badge variant="secondary">{item.status}</Badge>
              ) : null}
            </View>
          </View>
          {item.description ? (
            <Text className="text-muted-foreground text-sm mt-1" numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
          <Text className="text-muted-foreground text-xs mt-2">
            Updated {new Date(item.updatedAt).toLocaleDateString()}
          </Text>
        </Pressable>
      </CardContent>
    </Card>
  )

  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pt-4 pb-2 flex-row justify-between items-center">
        <View>
          <Text className="text-2xl font-bold text-foreground">Projects</Text>
          <Text className="text-muted-foreground text-sm mt-1">
            {userName ? `${userName}'s workspace` : 'Your Shogo workspace'}
          </Text>
        </View>
        {onCreateProject ? (
          <Button size="sm" onPress={() => setShowCreate(true)}>
            + New Agent
          </Button>
        ) : null}
      </View>

      {onSearchChange ? (
        <View className="px-4 pb-3">
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChangeText={onSearchChange}
          />
        </View>
      ) : null}

      {isLoading ? (
        <View className="px-4 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </View>
      ) : filtered.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-muted-foreground text-center mb-4">
            {searchQuery
              ? 'No projects match your search.'
              : 'No projects yet. Create your first AI agent!'}
          </Text>
          {!searchQuery && onCreateProject ? (
            <Button onPress={() => setShowCreate(true)}>Create Agent</Button>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={renderProjectCard}
        />
      )}

      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => { setShowCreate(false); setNewName(''); setCreateError(null) }}>
        <View className="flex-1 justify-center items-center bg-black/50 px-6">
          <Card className="w-full max-w-sm">
            <CardContent className="p-6">
              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-lg font-bold text-foreground">Create New Agent</Text>
                <Pressable onPress={() => { setShowCreate(false); setNewName(''); setCreateError(null) }} className="p-1">
                  <Text className="text-muted-foreground text-lg leading-none">✕</Text>
                </Pressable>
              </View>
              <Input
                placeholder="Agent name"
                value={newName}
                onChangeText={setNewName}
                autoFocus
              />
              {createError ? (
                <Text className="text-destructive text-sm mt-2">{createError}</Text>
              ) : null}
              <View className="flex-row gap-3 mt-4">
                <Button
                  variant="outline"
                  className="flex-1"
                  onPress={() => { setShowCreate(false); setNewName(''); setCreateError(null) }}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onPress={handleCreate}
                  disabled={creating || !newName.trim()}
                >
                  {creating ? <ActivityIndicator color="#fff" size="small" /> : 'Create'}
                </Button>
              </View>
            </CardContent>
          </Card>
        </View>
      </Modal>
    </View>
  )
}
