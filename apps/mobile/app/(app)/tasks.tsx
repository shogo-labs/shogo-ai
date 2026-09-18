// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Keyboard, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Check, CheckCircle2, CircleAlert, Clock3, Folder, ListTodo, LoaderCircle, Play, Plus, Search, Trash2, X, XCircle } from 'lucide-react-native'
import { useProjectCollection, type IProject } from '../../contexts/domain'
import { useResolvedTheme } from '../../contexts/theme'
import { useIsRemoteSource } from '@shogo/shared-app/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, createHttpClient, type AgentTask, type AgentTaskStatus } from '../../lib/api'
import { agentTaskEvents } from '../../lib/agent-task-events'
import { NativePhoneSheet } from '../../components/phone/NativePhoneSheet'
import { PhoneListEmpty } from '../../components/phone/PhoneListRow'
import { readableAgentTaskError, taskStatusLabel } from '../../lib/agent-task-ui'
import { getPinnedProjectIds } from '../../lib/project-prefs-store'

function statusClass(status: AgentTaskStatus) {
  switch (status) {
    case 'completed': return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    case 'failed': return 'bg-destructive/15 text-red-700 dark:text-red-300'
    case 'cancelled': return 'bg-muted text-muted-foreground'
    case 'running': return 'bg-background text-primary'
    case 'queued': return 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
    default: return 'bg-muted text-muted-foreground'
  }
}

function statusIcon(status: AgentTaskStatus) {
  switch (status) {
    case 'completed': return CheckCircle2
    case 'running': return LoaderCircle
    case 'queued': return Clock3
    case 'failed': return XCircle
    case 'cancelled': return XCircle
    default: return ListTodo
  }
}

function statusIconClass(status: AgentTaskStatus) {
  switch (status) {
    case 'completed': return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    case 'failed': return 'bg-destructive/15 text-red-700 dark:text-red-300'
    case 'cancelled': return 'bg-muted text-muted-foreground'
    case 'running': return 'bg-background text-primary'
    case 'queued': return 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
    default: return 'bg-muted text-muted-foreground'
  }
}

function projectTimestamp(project: IProject): number {
  return Math.max(project.createdAt || 0, project.updatedAt || 0, project.lastMessageAt || 0)
}

function StatusBadge({ status }: { status: AgentTaskStatus }) {
  const className = statusClass(status)
  const textClass = status === 'completed'
    ? 'text-emerald-700 dark:text-emerald-300'
    : status === 'failed'
      ? 'text-red-700 dark:text-red-300'
      : status === 'queued'
        ? 'text-amber-800 dark:text-amber-200'
        : 'text-foreground'
  return (
    <View className={`flex-row items-center gap-1 rounded-full px-3 py-2 ${className}`}>
      {status === 'completed' ? <Check size={13} className="text-emerald-700 dark:text-emerald-300" /> : null}
      <Text className={`text-[12px] font-semibold ${textClass}`}>{taskStatusLabel(status)}</Text>
    </View>
  )
}

const TasksScreen = observer(function TasksScreen() {
  const router = useRouter()
  const http = useMemo(() => createHttpClient(), [])
  const workspace = useActiveWorkspace()
  const projects = useProjectCollection()
  const isRemoteSource = useIsRemoteSource()
  const isDark = useResolvedTheme() === 'dark'
  const primaryActionColor = isDark ? '#18181b' : '#ffffff'
  const params = useLocalSearchParams<{ projectId?: string; taskId?: string }>()
  const requestedProjectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId
  const requestedTaskId = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId

  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(requestedProjectId ?? null)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const loadInFlight = useRef<Promise<void> | null>(null)
  const taskOffsets = useRef(new Map<string, number>())
  const taskListRef = useRef<ScrollView>(null)
  const createSheetScrollRef = useRef<ScrollView>(null)
  const projectSearchScrollFrame = useRef<number | null>(null)

  useEffect(() => {
    if (!workspace?.id) return
    void projects.loadAll({ workspaceId: workspace.id }).catch(() => undefined)
  }, [projects, workspace?.id])

  const keepProjectSearchVisible = useCallback(() => {
    if (projectSearchScrollFrame.current !== null) return
    projectSearchScrollFrame.current = requestAnimationFrame(() => {
      projectSearchScrollFrame.current = null
      createSheetScrollRef.current?.scrollToEnd({ animated: false })
    })
  }, [])

  const toggleProjectSearch = useCallback(() => {
    if (projectSearchOpen) Keyboard.dismiss()
    setProjectSearchOpen((open) => !open)
  }, [projectSearchOpen])

  const load = useCallback(async () => {
    if (loadInFlight.current) return loadInFlight.current

    const request = (async () => {
      if (!workspace?.id) {
        setTasks([])
        setLoading(false)
        setRefreshing(false)
        return
      }
      try {
        setError(null)
        const next = await api.listAgentTasks(http)
        setTasks(next.filter((task) => task.workspaceId === workspace.id))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load tasks')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    })()

    loadInFlight.current = request
    const clearInFlight = () => {
      if (loadInFlight.current === request) loadInFlight.current = null
    }
    void request.then(clearInFlight, clearInFlight)
    return request
  }, [http, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
    return agentTaskEvents.subscribe(() => void load())
  }, [load]))

  useEffect(() => {
    if (requestedProjectId) setSelectedProjectId(requestedProjectId)
  }, [requestedProjectId])

  useEffect(() => {
    if (!requestedTaskId || !tasks.some((task) => task.id === requestedTaskId)) return
    const frame = requestAnimationFrame(() => {
      const offset = taskOffsets.current.get(requestedTaskId)
      if (offset != null) taskListRef.current?.scrollTo({ y: Math.max(0, offset - 16), animated: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [requestedTaskId, tasks])

  const activeTasks = useMemo(
    () => tasks.filter((task) => task.status === 'draft' || task.status === 'queued' || task.status === 'running'),
    [tasks],
  )
  const finishedTasks = useMemo(
    () => tasks.filter((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'),
    [tasks],
  )

  const resetCreate = () => {
    setTitle('')
    setNotes('')
    setSelectedProjectId(requestedProjectId ?? null)
    setProjectQuery('')
    setProjectSearchOpen(false)
    setError(null)
  }

  const createTask = async () => {
    if (!workspace?.id || !title.trim()) return
    try {
      setSaving(true)
      setError(null)
      const task = await api.createAgentTask(http, {
        workspaceId: workspace.id,
        projectId: selectedProjectId,
        title: title.trim(),
        notes: notes.trim() || undefined,
      })
      setTasks((current) => [task, ...current])
      setShowCreate(false)
      resetCreate()
      agentTaskEvents.emit()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save task')
    } finally {
      setSaving(false)
    }
  }

  const mutateTask = async (task: AgentTask, action: 'start' | 'cancel') => {
    try {
      setBusyTaskId(task.id)
      setError(null)
      const next = action === 'start'
        ? await api.startAgentTask(http, task.id)
        : await api.cancelAgentTask(http, task.id)
      setTasks((current) => current.map((item) => item.id === next.id ? next : item))
      agentTaskEvents.emit()
      if (action === 'start') openChat(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} task`)
    } finally {
      setBusyTaskId(null)
    }
  }

  const confirmDeleteTask = (task: AgentTask) => {
    const active = task.status === 'queued' || task.status === 'running'
    Alert.alert(
      active ? 'Cancel and delete task?' : 'Delete task?',
      active ? 'This will stop the agent work and remove the task.' : 'This will permanently remove the task from your history.',
      [
        { text: 'Keep task', style: 'cancel' },
        {
          text: active ? 'Cancel and delete' : 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                setBusyTaskId(task.id)
                setError(null)
                if (active) await api.cancelAgentTask(http, task.id)
                await api.deleteAgentTask(http, task.id)
                setTasks((current) => current.filter((item) => item.id !== task.id))
                agentTaskEvents.emit()
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not delete task')
              } finally {
                setBusyTaskId(null)
              }
            })()
          },
        },
      ],
    )
  }

  const openChat = (task: AgentTask) => {
    if (task.projectId) {
      router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: task.projectId, ...(task.chatSessionId ? { chatSessionId: task.chatSessionId } : {}) } } as any)
    } else {
      router.replace('/(app)' as any)
    }
  }

  const renderTask = (task: AgentTask) => {
    const busy = busyTaskId === task.id
    const StatusIcon = statusIcon(task.status)
    const showStatusIcon = task.status !== 'completed'
    return (
      <View
        key={task.id}
        onLayout={(event) => taskOffsets.current.set(task.id, event.nativeEvent.layout.y)}
        className="mx-4 mb-3 rounded-2xl border border-border bg-card p-4"
      >
        <View className="flex-row items-start gap-3">
          {showStatusIcon ? (
            <View className={`h-12 w-12 items-center justify-center rounded-2xl ${statusIconClass(task.status)}`}>
              <StatusIcon size={24} className={statusIconClass(task.status).split(' ')[1]} />
            </View>
          ) : null}
          <View className="min-w-0 flex-1">
            <View className="flex-row items-start justify-between gap-2">
              <Text className="flex-1 text-[17px] font-semibold leading-6 text-foreground" numberOfLines={2}>{task.title}</Text>
              <StatusBadge status={task.status} />
            </View>
            {task.currentStep ? <Text className="mt-2 text-[15px] leading-5 text-muted-foreground" numberOfLines={2}>{task.currentStep}</Text> : null}
          </View>
        </View>
        {task.notes ? <Text className="mt-4 rounded-xl bg-muted/60 px-3.5 py-3 text-[15px] leading-6 text-foreground" numberOfLines={4}>{task.notes}</Text> : null}
        {task.status !== 'completed' && task.resultSummary ? <Text className="mt-4 rounded-xl bg-muted/60 px-3.5 py-3 text-[15px] leading-6 text-foreground" numberOfLines={3}>{task.resultSummary}</Text> : null}
        {task.errorMessage ? <Text className="mt-4 text-[15px] leading-6 text-destructive" numberOfLines={3}>{readableAgentTaskError(task.errorMessage)}</Text> : null}
        <View className="mt-4 flex-row items-center gap-2" style={{ borderTopWidth: 0, borderBottomWidth: 0 }}>
          {task.status === 'draft' ? (
            <Pressable onPress={() => void mutateTask(task, 'start')} disabled={busy} className="h-12 flex-row items-center gap-2 rounded-full bg-primary px-4 active:opacity-80">
              {busy ? <ActivityIndicator size="small" color={primaryActionColor} /> : <Play size={18} color={primaryActionColor} />}
              <Text className="text-[15px] font-semibold text-primary-foreground">Start agent</Text>
            </Pressable>
          ) : null}
          {(task.status === 'queued' || task.status === 'running') ? (
            <Pressable onPress={() => void mutateTask(task, 'cancel')} disabled={busy} className="h-12 flex-row items-center gap-2 rounded-full bg-muted px-4 active:opacity-80">
              <XCircle size={18} className="text-foreground" />
              <Text className="text-[15px] font-medium text-foreground">Cancel</Text>
            </Pressable>
          ) : null}
          {task.chatSessionId ? (
            <Pressable onPress={() => openChat(task)} className="h-12 flex-row items-center rounded-full border border-primary px-4 active:bg-primary/10">
              <Text className="text-[15px] font-medium text-primary">Open chat</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => confirmDeleteTask(task)} disabled={busy} accessibilityLabel="Delete task" className="ml-auto h-11 w-11 items-center justify-center rounded-xl active:bg-muted disabled:opacity-50">
            <Trash2 size={19} className="text-red-400 dark:text-red-300" />
          </Pressable>
        </View>
      </View>
    )
  }

  const projectPickerGroups = useMemo(() => {
    const pinnedIds = new Set(getPinnedProjectIds())
    const query = projectQuery.trim().toLowerCase()
    const workspaceProjects = projects.all
      .filter((project) => isRemoteSource || project.workspaceId === workspace?.id)
      .filter((project) => !query || project.name.toLowerCase().includes(query))
      .sort((a, b) => projectTimestamp(b) - projectTimestamp(a))

    return {
      pinned: workspaceProjects.filter((project) => pinnedIds.has(project.id)),
      recent: workspaceProjects.filter((project) => !pinnedIds.has(project.id)),
    }
  }, [isRemoteSource, projectQuery, projects.all, workspace?.id])

  const renderProjectChip = (project: IProject) => {
    const selected = selectedProjectId === project.id
    return (
      <Pressable key={project.id} onPress={() => setSelectedProjectId(selected ? null : project.id)} accessibilityRole="radio" accessibilityState={{ selected }} className={`h-11 max-w-[190px] flex-row items-center gap-1.5 rounded-full border px-3.5 ${selected ? 'border-primary bg-primary/10' : 'border-border bg-muted'}`}>
        {selected ? <Check size={15} className="text-primary" /> : <Folder size={14} className="text-muted-foreground" />}
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{project.name}</Text>
      </Pressable>
    )
  }

  useEffect(() => {
    if (!projectSearchOpen) return
    // Pin the form after the search field opens. Subsequent filter changes are
    // handled by the sheet's content-size callback after their layout pass.
    keepProjectSearchVisible()
  }, [keepProjectSearchVisible, projectSearchOpen])

  useEffect(() => {
    if (!projectSearchOpen) return
    // The keyboard inset changes the visible scroll viewport without changing
    // the sheet content size, so re-pin after the keyboard finishes opening.
    const subscription = Keyboard.addListener('keyboardDidShow', keepProjectSearchVisible)
    return () => subscription.remove()
  }, [keepProjectSearchVisible, projectSearchOpen])

  useEffect(() => () => {
    if (projectSearchScrollFrame.current !== null) cancelAnimationFrame(projectSearchScrollFrame.current)
  }, [])

  return (
    <View className="flex-1 bg-background">
      {error ? (
        <View className="mx-4 mt-3 flex-row items-start gap-2 rounded-2xl border border-destructive bg-destructive/10 px-3 py-3">
          <CircleAlert size={18} className="mt-0.5 text-destructive" />
          <Text className="flex-1 text-sm leading-5 text-destructive">{readableAgentTaskError(error, 'We could not refresh your tasks.')}</Text>
          <Pressable onPress={() => { setError(null); setRefreshing(true); void load() }} accessibilityLabel="Try loading tasks again" className="rounded-lg px-2 py-1 active:bg-destructive/10">
            <Text className="text-sm font-semibold text-destructive">Try again</Text>
          </Pressable>
        </View>
      ) : null}
      {loading ? <View className="flex-1 items-center justify-center"><ActivityIndicator /></View> : (
        <ScrollView ref={taskListRef} className="flex-1" contentContainerStyle={{ paddingTop: 16, paddingBottom: 112 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}>
          {activeTasks.length > 0 ? <View className="mb-3 flex-row items-center justify-between px-4"><Text className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Active and drafts</Text><Text className="text-[13px] text-muted-foreground">{activeTasks.length}</Text></View> : null}
          {activeTasks.map(renderTask)}
          {finishedTasks.length > 0 ? <View className="mb-3 mt-3 flex-row items-center justify-between px-4"><Text className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">History</Text><Text className="text-[13px] text-muted-foreground">{finishedTasks.length}</Text></View> : null}
          {finishedTasks.map(renderTask)}
          {tasks.length === 0 ? <PhoneListEmpty icon={<ListTodo size={44} className="text-muted-foreground" />} title="No tasks yet" message="Create a task from Home or a project, then start the agent when you are ready." action={<Pressable onPress={() => { resetCreate(); setShowCreate(true) }} className="rounded-lg bg-primary px-4 py-2"><Text className="font-semibold text-primary-foreground">Create task</Text></Pressable>} /> : null}
        </ScrollView>
      )}

      <Pressable
        onPress={() => { resetCreate(); setShowCreate(true) }}
        accessibilityLabel="Create task"
        className="h-14 w-14 items-center justify-center rounded-full bg-primary shadow-lg active:opacity-80"
        // The task screen sits immediately above the nav capsule, which has a
        // negative top margin on native phones. Keep the FAB clear of that
        // overlap while leaving a small visual gap above the bar.
        style={{ position: 'absolute', bottom: 44, left: '50%', transform: [{ translateX: -28 }], zIndex: 20 }}
      >
        <Plus size={23} color={primaryActionColor} />
      </Pressable>

      <NativePhoneSheet
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        title="New task"
        headerTitleAlign="left"
        headerBorder
        scroll
        scrollRef={createSheetScrollRef}
        onContentSizeChange={projectSearchOpen ? keepProjectSearchVisible : undefined}
        keyboardBehavior="scroll"
        maxHeightRatio={0.84}
        draggable
        animationType="slide"
        footer={(
          <View className="border-t border-border bg-card px-4 pb-1 pt-3">
            <Pressable onPress={() => void createTask()} disabled={saving || !title.trim()} className="h-12 items-center justify-center rounded-2xl bg-primary shadow-sm active:opacity-80 disabled:opacity-50">
              <Text className="text-base font-semibold text-primary-foreground">{saving ? 'Saving…' : 'Save draft'}</Text>
            </Pressable>
          </View>
        )}
      >
        <View className="gap-6 px-4 pb-5 pt-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Task details</Text>
            <Text className="text-xs text-muted-foreground">Required fields marked *</Text>
          </View>
          <View className="border-b border-border pb-5">
            <Text className="mb-2 text-[13px] font-semibold text-foreground">What do you need to do? <Text className="text-primary">*</Text></Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Research hotels for Goa"
              placeholderTextColor={isDark ? '#a3a3a3' : '#52525b'}
              selectionColor={isDark ? '#f09050' : '#c2410c'}
              returnKeyType="next"
              className="min-h-14 rounded-2xl border border-border bg-muted/70 px-4 py-3.5 text-base text-foreground"
              accessibilityLabel="Task title"
            />
          </View>
          <View>
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-[13px] font-semibold text-foreground">Notes</Text>
              <Text className="text-xs text-muted-foreground">Optional</Text>
            </View>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Add context for the agent"
              placeholderTextColor={isDark ? '#a3a3a3' : '#52525b'}
              selectionColor={isDark ? '#f09050' : '#c2410c'}
              multiline
              className="min-h-28 rounded-2xl border border-border bg-muted/70 px-4 py-3.5 text-base leading-5 text-foreground"
              textAlignVertical="top"
              accessibilityLabel="Task notes"
            />
          </View>
          <View>
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-[13px] font-semibold text-foreground">Project</Text>
              <View className="flex-row items-center gap-2.5">
                <Text className="text-xs text-muted-foreground">Optional</Text>
                <Pressable
                  onPress={toggleProjectSearch}
                  accessibilityRole="button"
                  accessibilityLabel="Search projects"
                  accessibilityHint={projectSearchOpen ? 'Hide project search and dismiss the keyboard' : 'Show project search'}
                  className={`h-10 w-10 items-center justify-center rounded-2xl border ${projectSearchOpen ? 'border-primary bg-primary/10' : 'border-border bg-muted/70'}`}
                >
                  <Search size={18} className={projectSearchOpen ? 'text-primary' : 'text-foreground'} />
                </Pressable>
              </View>
            </View>
            {projectSearchOpen ? (
              <View className="mt-3 h-12 flex-row items-center rounded-2xl border border-border bg-muted/70 px-3.5">
                <Search size={18} className="text-muted-foreground" />
                <TextInput
                  value={projectQuery}
                  onChangeText={setProjectQuery}
                  placeholder="Search projects"
                  placeholderTextColor={isDark ? '#a3a3a3' : '#52525b'}
                  selectionColor={isDark ? '#f09050' : '#c2410c'}
                  autoFocus
                  returnKeyType="search"
                  className="h-12 flex-1 px-2.5 text-base text-foreground"
                  accessibilityLabel="Search projects"
                />
                {projectQuery ? (
                  <Pressable onPress={() => setProjectQuery('')} accessibilityLabel="Clear project search" className="h-8 w-8 items-center justify-center rounded-full">
                    <X size={15} className="text-muted-foreground" />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {projectPickerGroups.pinned.length > 0 ? (
              <View className="mt-4">
                <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pinned</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2" accessibilityLabel="Choose a pinned project">
                  {projectPickerGroups.pinned.map(renderProjectChip)}
                </ScrollView>
              </View>
            ) : null}
            {projectPickerGroups.recent.length > 0 ? (
              <View className="mt-4">
                <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent projects</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2" accessibilityLabel="Choose a recent project">
                  {projectPickerGroups.recent.map(renderProjectChip)}
                </ScrollView>
              </View>
            ) : null}
            {projectSearchOpen && projectPickerGroups.pinned.length === 0 && projectPickerGroups.recent.length === 0 ? (
              <Text className="mt-4 text-sm text-muted-foreground">No projects match “{projectQuery}”.</Text>
            ) : null}
          </View>
        </View>
      </NativePhoneSheet>
    </View>
  )
})

export default TasksScreen
