/**
 * Kanban Board App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'

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

  const fetchBoards = useCallback(async () => {
    if (!auth.user) return
    try {
      const res = await fetch(`/api/boards?userId=${auth.user.id}`)
      if (res.ok) {
        const data = await res.json()
        setBoards(data.items || [])
      }
    } catch (err) {
      console.error('Failed to fetch boards:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  const fetchBoardDetails = useCallback(async (boardId: string) => {
    try {
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
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, userId: auth.user.id }),
      })
      if (res.ok) {
        setShowAddBoard(false)
        fetchBoards()
      }
    } catch (err) {
      console.error('Failed to create board:', err)
    }
  }

  const handleDeleteBoard = async (id: string) => {
    if (!confirm('Delete this board and all its cards?')) return
    await fetch(`/api/boards/${id}`, { method: 'DELETE' })
    if (selectedBoard?.id === id) setSelectedBoard(null)
    fetchBoards()
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading...</p></div>
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
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">📋 Kanban Board</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-500">{auth.user?.name || auth.user?.email}</span>
          <button onClick={() => auth.signOut()} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Sign Out</button>
        </div>
      </header>

      <div className="p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Your Boards</h2>
          <button onClick={() => setShowAddBoard(true)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            + New Board
          </button>
        </div>

        {showAddBoard && (
          <AddBoardForm onAdd={handleCreateBoard} onCancel={() => setShowAddBoard(false)} />
        )}

        {boards.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">No boards yet. Create your first board to get started!</p>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
            {boards.map(board => (
              <div
                key={board.id}
                className="bg-white rounded-xl p-5 shadow-sm cursor-pointer hover:shadow-md transition"
                onClick={() => fetchBoardDetails(board.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: board.color }} />
                    <h3 className="font-semibold text-gray-900">{board.name}</h3>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteBoard(board.id) }}
                    className="text-gray-400 hover:text-red-500"
                  >×</button>
                </div>
                {board.description && <p className="text-gray-500 text-sm mt-2 truncate">{board.description}</p>}
              </div>
            ))}
          </div>
        )}

        <footer className="text-center text-gray-400 text-sm mt-8">Built with @shogo-ai/sdk + Hono</footer>
      </div>
    </div>
  )
})

function AddBoardForm({ onAdd, onCancel }: { onAdd: (name: string, color: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#3B82F6')

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
      <h3 className="font-semibold text-gray-900 mb-4">Create New Board</h3>
      <div className="flex gap-4 items-end">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Board name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
          />
        </div>
        <div>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-12 h-12 rounded cursor-pointer"
            style={{ padding: 0, border: 'none' }}
          />
        </div>
        <button onClick={() => name && onAdd(name, color)} className="px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          Create
        </button>
        <button onClick={onCancel} className="px-4 py-3 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  )
}

function BoardView({ board, userId, onBack, onUpdate }: { board: BoardType; userId: string; onBack: () => void; onUpdate: () => void }) {
  const [showAddColumn, setShowAddColumn] = useState(false)
  const [addingCardToColumn, setAddingCardToColumn] = useState<string | null>(null)

  const columns = (board.columns || []).sort((a, b) => a.position - b.position)

  const handleAddColumn = async (name: string) => {
    try {
      const maxPos = Math.max(0, ...columns.map(c => c.position))
      await fetch('/api/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, boardId: board.id, position: maxPos + 1 }),
      })
      setShowAddColumn(false)
      onUpdate()
    } catch (err) {
      console.error('Failed to add column:', err)
    }
  }

  const handleDeleteColumn = async (columnId: string) => {
    if (!confirm('Delete this column and all its cards?')) return
    await fetch(`/api/columns/${columnId}`, { method: 'DELETE' })
    onUpdate()
  }

  const handleAddCard = async (columnId: string, title: string) => {
    const column = columns.find(c => c.id === columnId)
    const cards = column?.cards || []
    const maxPos = Math.max(0, ...cards.map(c => c.position))
    try {
      await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, columnId, userId, position: maxPos + 1 }),
      })
      setAddingCardToColumn(null)
      onUpdate()
    } catch (err) {
      console.error('Failed to add card:', err)
    }
  }

  const handleDeleteCard = async (cardId: string) => {
    await fetch(`/api/cards/${cardId}`, { method: 'DELETE' })
    onUpdate()
  }

  const handleMoveCard = async (cardId: string, newColumnId: string) => {
    const targetColumn = columns.find(c => c.id === newColumnId)
    const cards = targetColumn?.cards || []
    const maxPos = Math.max(0, ...cards.map(c => c.position))
    try {
      await fetch(`/api/cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: newColumnId, position: maxPos + 1 }),
      })
      onUpdate()
    } catch (err) {
      console.error('Failed to move card:', err)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: board.color + '10' }}>
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="text-gray-500 hover:text-gray-700">← Back</button>
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: board.color }} />
            <h1 className="text-xl font-bold text-gray-900">{board.name}</h1>
          </div>
        </div>
        <button onClick={() => setShowAddColumn(true)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Add Column
        </button>
      </header>

      <div className="flex-1 p-6 overflow-x-auto">
        <div className="flex gap-4 items-start" style={{ minWidth: 'max-content' }}>
          {columns.map(column => (
            <div key={column.id} className="w-72 min-w-72 bg-gray-100 rounded-xl p-4 shrink-0">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-gray-900">{column.name}</h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">{(column.cards || []).length}</span>
                  <button onClick={() => handleDeleteColumn(column.id)} className="text-gray-400 hover:text-red-500">×</button>
                </div>
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
                  <button
                    onClick={() => setAddingCardToColumn(column.id)}
                    className="w-full p-3 border border-dashed border-gray-300 rounded-lg text-gray-400 text-sm hover:border-gray-400 hover:text-gray-500"
                  >
                    + Add Card
                  </button>
                )}
              </div>
            </div>
          ))}

          {showAddColumn && (
            <div className="w-72 min-w-72 bg-white rounded-xl p-4 shrink-0">
              <AddColumnForm onAdd={handleAddColumn} onCancel={() => setShowAddColumn(false)} />
            </div>
          )}

          {!showAddColumn && columns.length === 0 && (
            <div className="text-center py-12 w-full">
              <p className="text-gray-400">Add your first column to start organizing tasks.</p>
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
    <div className="bg-white rounded-lg p-3 shadow-sm hover:shadow-md transition cursor-move">
      <div className="flex justify-between items-start">
        <p className="text-sm font-medium text-gray-900">{card.title}</p>
        <div className="flex gap-1">
          <button onClick={() => setShowMoveMenu(!showMoveMenu)} className="text-gray-400 hover:text-gray-600 text-xs">↔</button>
          <button onClick={onDelete} className="text-gray-400 hover:text-red-500">×</button>
        </div>
      </div>
      {card.description && <p className="text-xs text-gray-500 mt-1 truncate">{card.description}</p>}
      {card.dueDate && (
        <p className="text-xs text-gray-400 mt-2">Due: {new Date(card.dueDate).toLocaleDateString()}</p>
      )}
      {card.labels && card.labels.length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {card.labels.map(({ label }) => (
            <span key={label.id} className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: label.color + '30', color: label.color }}>
              {label.name}
            </span>
          ))}
        </div>
      )}

      {showMoveMenu && (
        <div className="mt-2 p-2 bg-gray-50 rounded text-xs">
          <p className="text-gray-500 mb-1">Move to:</p>
          {columns.filter(c => c.id !== card.columnId).map(col => (
            <button
              key={col.id}
              onClick={() => { onMove(col.id); setShowMoveMenu(false) }}
              className="block w-full text-left px-2 py-1 hover:bg-gray-100 rounded"
            >
              {col.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AddCardForm({ onAdd, onCancel }: { onAdd: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')

  return (
    <div className="bg-white rounded-lg p-3 shadow-sm">
      <input
        type="text"
        placeholder="Card title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-3 py-2 border border-gray-200 rounded text-sm mb-2"
        autoFocus
      />
      <div className="flex gap-2">
        <button onClick={() => title && onAdd(title)} className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          Add
        </button>
        <button onClick={onCancel} className="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  )
}

function AddColumnForm({ onAdd, onCancel }: { onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')

  return (
    <div>
      <input
        type="text"
        placeholder="Column name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full px-3 py-2 border border-gray-200 rounded text-sm mb-2"
        autoFocus
      />
      <div className="flex gap-2">
        <button onClick={() => name && onAdd(name)} className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          Add
        </button>
        <button onClick={onCancel} className="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  )
}
