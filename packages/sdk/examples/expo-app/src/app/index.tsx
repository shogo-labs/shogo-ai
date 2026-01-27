/**
 * Todo App - Expo/React Native Version
 *
 * Demonstrates:
 * - Auto-generated API client (HTTP-based)
 * - Auto-generated domain store with optimistic updates
 * - React Native components
 */

import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useStores, type TodoType, type UserType } from '../stores'
import { initializeApi } from '../lib/api'
import { api, configureApiClient } from '../generated/api-client'

export default function HomeScreen() {
  const [user, setUser] = useState<UserType | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Check for existing user on mount
  useEffect(() => {
    const checkUser = async () => {
      try {
        const result = await api.user.list()
        if (result.ok && result.items && result.items.length > 0) {
          const existingUser = result.items[0]
          setUser(existingUser)
          initializeApi(existingUser.id)
        }
      } catch (err) {
        console.error('Failed to check user:', err)
      } finally {
        setIsLoading(false)
      }
    }
    checkUser()
  }, [])

  const handleUserCreated = (newUser: UserType) => {
    setUser(newUser)
    initializeApi(newUser.id)
  }

  const handleSignOut = () => {
    setUser(null)
    configureApiClient({ userId: undefined })
  }

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    )
  }

  if (!user) {
    return <SetupScreen onUserCreated={handleUserCreated} />
  }

  return <TodoScreen user={user} onSignOut={handleSignOut} />
}

// ============================================================================
// Setup Screen
// ============================================================================

function SetupScreen({ onUserCreated }: { onUserCreated: (user: UserType) => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!email.trim()) {
      setError('Email is required')
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const result = await api.user.create({ email: email.trim(), name: name.trim() || undefined })
      if (result.ok && result.data) {
        onUserCreated(result.data)
      } else {
        setError(result.error?.message || 'Failed to create user')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <Stack.Screen options={{ title: 'Welcome' }} />
      <View style={styles.card}>
        <Text style={styles.title}>Todo App</Text>
        <Text style={styles.subtitle}>Built with @shogo-ai/sdk + Expo</Text>

        <TextInput
          style={styles.input}
          placeholder="Email address"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          editable={!isLoading}
        />

        <TextInput
          style={styles.input}
          placeholder="Name (optional)"
          value={name}
          onChangeText={setName}
          editable={!isLoading}
        />

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, isLoading && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Get Started</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.footerText}>Uses auto-generated API from Prisma</Text>
      </View>
    </KeyboardAvoidingView>
  )
}

// ============================================================================
// Todo Screen
// ============================================================================

const TodoScreen = observer(function TodoScreen({
  user,
  onSignOut,
}: {
  user: UserType
  onSignOut: () => void
}) {
  const store = useStores()
  const [newTitle, setNewTitle] = useState('')
  const [initialized, setInitialized] = useState(false)

  // Load todos on mount
  useEffect(() => {
    if (!initialized) {
      store.todo.loadAll()
      setInitialized(true)
    }
  }, [initialized, store.todo])

  // Get todos from store (sorted by createdAt desc)
  const todos = store.todo.all.slice().sort((a, b) => {
    const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt)
    const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt)
    return dateB.getTime() - dateA.getTime()
  })

  const completedCount = todos.filter(t => t.completed).length
  const pendingCount = todos.filter(t => !t.completed).length

  const handleAdd = async () => {
    if (!newTitle.trim()) return

    try {
      await store.todo.create({
        title: newTitle.trim(),
        completed: false,
        userId: user.id,
      })
      setNewTitle('')
    } catch (err) {
      Alert.alert('Error', 'Failed to create todo')
    }
  }

  const handleToggle = async (todo: TodoType) => {
    try {
      await store.todo.update(todo.id, { completed: !todo.completed })
    } catch (err) {
      Alert.alert('Error', 'Failed to update todo')
    }
  }

  const handleDelete = async (id: string) => {
    Alert.alert('Delete Todo', 'Are you sure you want to delete this todo?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await store.todo.delete(id)
          } catch (err) {
            Alert.alert('Error', 'Failed to delete todo')
          }
        },
      },
    ])
  }

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        onPress: () => {
          store.clearAll()
          onSignOut()
        },
      },
    ])
  }

  const renderTodoItem = ({ item }: { item: TodoType }) => (
    <View style={[styles.todoItem, store.todo.isPending(item.id) && styles.todoItemPending]}>
      <TouchableOpacity
        style={styles.checkbox}
        onPress={() => handleToggle(item)}
        disabled={store.todo.isPending(item.id)}
      >
        <View style={[styles.checkboxInner, item.completed && styles.checkboxChecked]}>
          {item.completed && <Text style={styles.checkmark}>✓</Text>}
        </View>
      </TouchableOpacity>

      <Text style={[styles.todoText, item.completed && styles.todoTextCompleted]}>
        {item.title}
      </Text>

      <TouchableOpacity
        style={styles.deleteButton}
        onPress={() => handleDelete(item.id)}
        disabled={store.todo.isPending(item.id)}
      >
        <Text style={styles.deleteButtonText}>Delete</Text>
      </TouchableOpacity>
    </View>
  )

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <Stack.Screen
        options={{
          title: 'Todo App',
          headerRight: () => (
            <TouchableOpacity onPress={handleSignOut} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Sign Out</Text>
            </TouchableOpacity>
          ),
        }}
      />

      <View style={styles.content}>
        {/* User Info */}
        <View style={styles.userInfo}>
          <Text style={styles.userInfoText}>{user.name || user.email}</Text>
          <View style={styles.stats}>
            <Text style={styles.statText}>{pendingCount} pending</Text>
            <Text style={styles.statText}>{completedCount} completed</Text>
          </View>
        </View>

        {/* Add Todo Form */}
        <View style={styles.addForm}>
          <TextInput
            style={styles.addInput}
            placeholder="What needs to be done?"
            value={newTitle}
            onChangeText={setNewTitle}
            onSubmitEditing={handleAdd}
            returnKeyType="done"
          />
          <TouchableOpacity
            style={[styles.addButton, !newTitle.trim() && styles.buttonDisabled]}
            onPress={handleAdd}
            disabled={!newTitle.trim()}
          >
            <Text style={styles.addButtonText}>Add</Text>
          </TouchableOpacity>
        </View>

        {/* Error Display */}
        {store.todo.error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{store.todo.error}</Text>
            <TouchableOpacity onPress={() => store.todo.clearError()}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Todo List */}
        {store.todo.isLoading && todos.length === 0 ? (
          <View style={styles.emptyContainer}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={styles.emptyText}>Loading todos...</Text>
          </View>
        ) : todos.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No todos yet. Add one above!</Text>
          </View>
        ) : (
          <FlatList
            data={todos}
            renderItem={renderTodoItem}
            keyExtractor={(item) => item.id}
            style={styles.list}
            showsVerticalScrollIndicator={false}
          />
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Built with @shogo-ai/sdk + auto-generated stores
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
})

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 24,
    margin: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 24,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
    backgroundColor: '#fff',
  },
  button: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 14,
    marginBottom: 8,
  },
  footerText: {
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'center',
    marginTop: 16,
  },
  userInfo: {
    marginBottom: 16,
  },
  userInfoText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  stats: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 4,
  },
  statText: {
    fontSize: 12,
    color: '#6b7280',
  },
  addForm: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 8,
  },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  addButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  errorContainer: {
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dismissText: {
    color: '#dc2626',
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#9ca3af',
    marginTop: 8,
  },
  list: {
    flex: 1,
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  todoItemPending: {
    opacity: 0.6,
  },
  checkbox: {
    marginRight: 12,
  },
  checkboxInner: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: '#d1d5db',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
  },
  checkmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  todoText: {
    flex: 1,
    fontSize: 16,
    color: '#111827',
  },
  todoTextCompleted: {
    textDecorationLine: 'line-through',
    color: '#9ca3af',
  },
  deleteButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
  },
  deleteButtonText: {
    fontSize: 12,
    color: '#6b7280',
  },
  headerButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  headerButtonText: {
    color: '#fff',
    fontSize: 14,
  },
  footer: {
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
})
