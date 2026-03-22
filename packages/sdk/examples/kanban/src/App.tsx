// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Kanban Board App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  LayoutDashboard,
  Plus,
  Trash2,
  X,
  ArrowLeft,
  GripVertical,
  LogOut,
  Loader2,
  MoveHorizontal,
  Columns,
} from 'lucide-react'

interface LabelType {
  id: string
  name: string
  color: string
}

interface CardType {
  id: string
  title: string
  description: string | null
  position: number
  dueDate: string | null
  columnId: string
  labels?: { label: LabelType }[]
}

interface ColumnType {
  id: string
  name: string
  position: number
  boardId: string
  cards?: CardType[]
}

interface BoardType {
  id: string
  name: string
  description: string | null
  color: string
  columns?: ColumnType[]
  labels?: LabelType[]
}

export default function App() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}

const Dashboard = observer(function Dashboard() {
  const { auth } = useStores()
  const [boards, setBoards] = useState<BoardType[]>([])
  const [selectedBoard, setSelectedBoard] = useState<BoardType | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddBoard, setShowAddBoard] = useState(false)

  // Configure API client with user context
  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const fetchBoards = useCallback(async () => {
    if (!auth.user) return
    try {
      const result = await api.board.list()
      if (result.ok) {
        setBoards((result.items || []) as any)
      }
    } catch (err) {
      console.error('Failed to fetch boards:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  const fetchBoardDetails = useCallback(async (boardId: string) => {
    try {
      // Custom endpoint - not covered by generated API client
      const res = await fetch(`/api/boards/${boardId}/full`)
      if (res.ok) {
        const board = await res.json()
        setSelectedBoard(board)
      }
    } catch (err) {
      console.error('Failed to fetch board:', err)
    }
  }, [])

  useEffect(() => { fetchBoards() }, [fetchBoards])

  const handleCreateBoard = async (name: string, color: string) => {
    if (!auth.user) return
    try {
      const result = await api.board.create({ name, color, userId: auth.user.id } as any)
      if (result.ok) {
        setShowAddBoard(false)
        fetchBoards()
      }
    } catch (err) {
      console.error('Failed to create board:', err)
    }
  }

  const handleDeleteBoard = async (id: string) => {
    if (!confirm('Delete this board and all its cards?')) return
    await api.board.delete(id)
    if (selectedBoard?.id === id) setSelectedBoard(null)
    fetchBoards()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  // Board detail view
  if (selectedBoard) {
    return (
      <BoardView
        board={selectedBoard}
        userId={auth.user!.id}
        onBack={() => setSelectedBoard(null)}
        onUpdate={() => fetchBoardDetails(selectedBoard.id)}
      />
    )
  }

  // Board list view
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background border-b px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Kanban Board</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{auth.user?.name || auth.user?.email}</span>
          <Button variant="outline" size="sm" onClick={() => auth.signOut()}>
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </header>

      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold">Your Boards</h2>
          <Button onClick={() => setShowAddBoard(true)}>
            <Plus className="h-4 w-4" />
            New Board
          </Button>
        </div>

        {showAddBoard && (
          <AddBoardForm onAdd={handleCreateBoard} onCancel={() => setShowAddBoard(false)} />
        )}

        {boards.length === 0 ? (
          <div className="text-center py-16">
            <LayoutDashboard className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
            <p className="text-muted-foreground">No boards yet. Create your first board to get started!</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {boards.map(board => (
              <Card
                key={board.id}
                className="cursor-pointer hover:shadow-md transition-shadow group"
                onClick={() => fetchBoardDetails(board.id)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-3 w-3 rounded-full shrink-0"
                        style={{ backgroundColor: board.color }}
                      />
                      <CardTitle className="text-base">{board.name}</CardTitle>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); handleDeleteBoard(board.id) }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {board.description && (
                    <p className="text-sm text-muted-foreground truncate">{board.description}</p>
                  )}
                </CardHeader>
              </Card>
            ))}
          </div>
        )}

        <footer className="text-center text-muted-foreground text-sm mt-8">
          Built with @shogo-ai/sdk + Hono
        </footer>
      </div>
    </div>
  )
})

function AddBoardForm({ onAdd, onCancel }: { onAdd: (name: string, color: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#3B82F6')

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Create New Board</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <Input
              type="text"
              placeholder="Board name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-10 h-10 rounded-md cursor-pointer border-0 p-0"
            />
          </div>
          <Button onClick={() => name && onAdd(name, color)}>
            Create
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function BoardView({ board, userId, onBack, onUpdate }: { board: BoardType; userId: string; onBack: () => void; onUpdate: () => void }) {
  const [showAddColumn, setShowAddColumn] = useState(false)
  const [addingCardToColumn, setAddingCardToColumn] = useState<string | null>(null)

  const columns = (board.columns || []).sort((a, b) => a.position - b.position)

  const handleAddColumn = async (name: string) => {
    try {
      const maxPos = Math.max(0, ...columns.map(c => c.position))
      await api.column.create({ name, boardId: board.id, position: maxPos + 1 } as any)
      setShowAddColumn(false)
      onUpdate()
    } catch (err) {
      console.error('Failed to add column:', err)
    }
  }

  const handleDeleteColumn = async (columnId: string) => {
    if (!confirm('Delete this column and all its cards?')) return
    await api.column.delete(columnId)
    onUpdate()
  }

  const handleAddCard = async (columnId: string, title: string) => {
    const column = columns.find(c => c.id === columnId)
    const cards = column?.cards || []
    const maxPos = Math.max(0, ...cards.map(c => c.position))
    try {
      await api.card.create({ title, columnId, userId, position: maxPos + 1 } as any)
      setAddingCardToColumn(null)
      onUpdate()
    } catch (err) {
      console.error('Failed to add card:', err)
    }
  }

  const handleDeleteCard = async (cardId: string) => {
    await api.card.delete(cardId)
    onUpdate()
  }

  const handleMoveCard = async (cardId: string, newColumnId: string) => {
    const targetColumn = columns.find(c => c.id === newColumnId)
    const cards = targetColumn?.cards || []
    const maxPos = Math.max(0, ...cards.map(c => c.position))
    try {
      await api.card.update(cardId, { columnId: newColumnId, position: maxPos + 1 } as any)
      onUpdate()
    } catch (err) {
      console.error('Failed to move card:', err)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: board.color + '10' }}>
      <header className="sticky top-0 z-10 bg-background border-b px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: board.color }}
            />
            <h1 className="text-xl font-bold">{board.name}</h1>
          </div>
        </div>
        <Button onClick={() => setShowAddColumn(true)}>
          <Plus className="h-4 w-4" />
          Add Column
        </Button>
      </header>

      <div className="flex-1 p-6 overflow-x-auto">
        <div className="flex gap-4 items-start" style={{ minWidth: 'max-content' }}>
          {columns.map(column => (
            <div key={column.id} className="w-72 min-w-72 rounded-xl bg-muted/50 p-4 shrink-0">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{column.name}</h3>
                  <Badge variant="secondary" className="text-xs">
                    {(column.cards || []).length}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => handleDeleteColumn(column.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="space-y-3">
                {(column.cards || []).sort((a, b) => a.position - b.position).map(card => (
                  <CardItem
                    key={card.id}
                    card={card}
                    columns={columns}
                    onDelete={() => handleDeleteCard(card.id)}
                    onMove={(newColumnId) => handleMoveCard(card.id, newColumnId)}
                  />
                ))}

                {addingCardToColumn === column.id ? (
                  <AddCardForm onAdd={(title) => handleAddCard(column.id, title)} onCancel={() => setAddingCardToColumn(null)} />
                ) : (
                  <Button
                    variant="outline"
                    className="w-full border-dashed text-muted-foreground"
                    onClick={() => setAddingCardToColumn(column.id)}
                  >
                    <Plus className="h-4 w-4" />
                    Add Card
                  </Button>
                )}
              </div>
            </div>
          ))}

          {showAddColumn && (
            <Card className="w-72 min-w-72 shrink-0">
              <CardContent className="pt-4">
                <AddColumnForm onAdd={handleAddColumn} onCancel={() => setShowAddColumn(false)} />
              </CardContent>
            </Card>
          )}

          {!showAddColumn && columns.length === 0 && (
            <div className="text-center py-16 w-full">
              <Columns className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
              <p className="text-muted-foreground">Add your first column to start organizing tasks.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CardItem({ card, columns, onDelete, onMove }: { card: CardType; columns: ColumnType[]; onDelete: () => void; onMove: (columnId: string) => void }) {
  const [showMoveMenu, setShowMoveMenu] = useState(false)

  return (
    <Card className="hover:shadow-md transition-shadow cursor-move py-3 gap-2">
      <CardContent className="px-3 py-0 space-y-1.5">
        <div className="flex justify-between items-start gap-2">
          <div className="flex items-start gap-2">
            <GripVertical className="h-4 w-4 text-muted-foreground/50 mt-0.5 shrink-0" />
            <p className="text-sm font-medium leading-snug">{card.title}</p>
          </div>
          <div className="flex gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setShowMoveMenu(!showMoveMenu)}
            >
              <MoveHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {card.description && (
          <p className="text-xs text-muted-foreground truncate pl-6">{card.description}</p>
        )}

        {card.dueDate && (
          <p className="text-xs text-muted-foreground pl-6">
            Due: {new Date(card.dueDate).toLocaleDateString()}
          </p>
        )}

        {card.labels && card.labels.length > 0 && (
          <div className="flex gap-1 flex-wrap pl-6">
            {card.labels.map(({ label }) => (
              <Badge
                key={label.id}
                variant="outline"
                className="text-[10px] px-1.5 py-0"
                style={{ backgroundColor: label.color + '20', color: label.color, borderColor: label.color + '40' }}
              >
                {label.name}
              </Badge>
            ))}
          </div>
        )}

        {showMoveMenu && (
          <div className="mt-1 p-2 bg-muted rounded-md">
            <p className="text-xs text-muted-foreground mb-1.5 font-medium">Move to:</p>
            <div className="space-y-0.5">
              {columns.filter(c => c.id !== card.columnId).map(col => (
                <Button
                  key={col.id}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-xs h-7"
                  onClick={() => { onMove(col.id); setShowMoveMenu(false) }}
                >
                  {col.name}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AddCardForm({ onAdd, onCancel }: { onAdd: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')

  return (
    <Card className="py-3 gap-2">
      <CardContent className="px-3 py-0 space-y-2">
        <Input
          type="text"
          placeholder="Card title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => title && onAdd(title)}>
            Add
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function AddColumnForm({ onAdd, onCancel }: { onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')

  return (
    <div className="space-y-2">
      <Input
        type="text"
        placeholder="Column name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => name && onAdd(name)}>
          Add
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
