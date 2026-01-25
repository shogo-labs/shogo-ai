/**
 * Kanban Board - Shogo SDK Example
 * 
 * Demonstrates:
 * - Position/ordering patterns for columns and cards
 * - Drag and drop between columns
 * - Many-to-many with labels
 * - Complex nested queries
 */

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getBoards, getBoard, createBoard, deleteBoard, type BoardType } from '../utils/boards'
import { createColumn, updateColumn, deleteColumn } from '../utils/columns'
import { createCard, updateCard, deleteCard, moveCard, addLabelToCard, removeLabelFromCard } from '../utils/cards'
import { createLabel, LABEL_COLORS, type LabelType } from '../utils/labels'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { boards: [], currentBoard: null }
    }
    const boards = await getBoards({ data: { userId: context.user.id } })
    const currentBoard = boards[0] 
      ? await getBoard({ data: { boardId: boards[0].id, userId: context.user.id } })
      : null
    return { boards, currentBoard }
  },
  component: KanbanApp,
})

function KanbanApp() {
  const { user } = Route.useRouteContext()
  const { boards, currentBoard } = Route.useLoaderData()
  const router = useRouter()
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(currentBoard?.id ?? null)

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  if (!selectedBoardId || !currentBoard) {
    return (
      <BoardSelector 
        user={user} 
        boards={boards} 
        onSelectBoard={(id) => {
          setSelectedBoardId(id)
          router.invalidate()
        }}
      />
    )
  }

  return (
    <KanbanBoard 
      user={user} 
      board={currentBoard}
      onBack={() => setSelectedBoardId(null)}
    />
  )
}

// ============================================================================
// Setup Form
// ============================================================================

function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setLoading(true)
    setError('')

    try {
      await createUser({ data: { email, name: name || undefined } })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-5">
      <div className="bg-white rounded-xl shadow-lg p-10 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Kanban Board</h1>
        <p className="text-gray-500 mb-6">Built with <strong>@shogo-ai/sdk</strong></p>

        <form onSubmit={handleSubmit} className="space-y-3 text-left">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            required
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-3 bg-sky-600 text-white rounded-lg font-medium hover:bg-sky-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Setting up...' : 'Get Started'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ============================================================================
// Board Selector
// ============================================================================

function BoardSelector({ 
  user, 
  boards,
  onSelectBoard 
}: { 
  user: UserType
  boards: { id: string; name: string; color: string }[]
  onSelectBoard: (id: string) => void
}) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [newBoardName, setNewBoardName] = useState('')
  const [loading, setLoading] = useState(false)

  const handleCreateBoard = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newBoardName.trim()) return

    setLoading(true)
    try {
      const board = await createBoard({ data: { name: newBoardName, userId: user.id } })
      setNewBoardName('')
      setShowForm(false)
      onSelectBoard(board.id)
      router.invalidate()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-10 max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-5">Your Boards</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {boards.map(board => (
          <div 
            key={board.id}
            onClick={() => onSelectBoard(board.id)}
            className="bg-white rounded-lg p-4 cursor-pointer hover:-translate-y-0.5 hover:shadow-lg transition-all border-l-4"
            style={{ borderColor: board.color }}
          >
            <h3 className="font-semibold text-gray-900">{board.name}</h3>
          </div>
        ))}
        
        {showForm ? (
          <div className="bg-white rounded-lg p-4 border-l-4 border-gray-300">
            <form onSubmit={handleCreateBoard}>
              <input
                type="text"
                placeholder="Board name"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                autoFocus
              />
              <div className="flex gap-2 mt-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-sky-600 text-white rounded text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-500 hover:text-gray-700 text-sm"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div
            onClick={() => setShowForm(true)}
            className="bg-white/25 border-2 border-dashed border-white/50 rounded-lg p-4 flex items-center justify-center text-white font-medium cursor-pointer hover:bg-white/30 min-h-[100px]"
          >
            + Create new board
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Kanban Board
// ============================================================================

function KanbanBoard({ 
  user, 
  board,
  onBack 
}: { 
  user: UserType
  board: BoardType
  onBack: () => void
}) {
  const router = useRouter()
  const [editingCard, setEditingCard] = useState<string | null>(null)
  const [draggedCard, setDraggedCard] = useState<{ cardId: string; columnId: string } | null>(null)

  const handleDeleteBoard = async () => {
    if (!confirm('Delete this board? This cannot be undone.')) return
    await deleteBoard({ data: { id: board.id, userId: user.id } })
    onBack()
    router.invalidate()
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: board.color }}>
      <header className="bg-black/15 px-4 py-2 flex items-center justify-between text-white">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 hover:bg-white/10 rounded">←</button>
          <h1 className="text-lg font-bold">{board.name}</h1>
        </div>
        <button onClick={handleDeleteBoard} className="px-3 py-1 text-sm hover:bg-white/10 rounded">
          Delete Board
        </button>
      </header>

      <div className="p-4 overflow-x-auto h-[calc(100vh-52px)]">
        <div className="flex gap-3 items-start h-full">
          {board.columns.map(column => (
            <Column
              key={column.id}
              column={column}
              board={board}
              user={user}
              draggedCard={draggedCard}
              setDraggedCard={setDraggedCard}
              onEditCard={setEditingCard}
            />
          ))}
          <AddColumn boardId={board.id} />
        </div>
      </div>

      {editingCard && (
        <CardModal
          cardId={editingCard}
          board={board}
          onClose={() => setEditingCard(null)}
        />
      )}
    </div>
  )
}

// ============================================================================
// Column Component
// ============================================================================

function Column({
  column,
  board,
  user,
  draggedCard,
  setDraggedCard,
  onEditCard,
}: {
  column: BoardType['columns'][0]
  board: BoardType
  user: UserType
  draggedCard: { cardId: string; columnId: string } | null
  setDraggedCard: (card: { cardId: string; columnId: string } | null) => void
  onEditCard: (cardId: string) => void
}) {
  const router = useRouter()
  const [isAddingCard, setIsAddingCard] = useState(false)
  const [newCardTitle, setNewCardTitle] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [columnName, setColumnName] = useState(column.name)
  const [dropTarget, setDropTarget] = useState<number | null>(null)

  const handleAddCard = async () => {
    if (!newCardTitle.trim()) return
    await createCard({ data: { title: newCardTitle, columnId: column.id, userId: user.id } })
    setNewCardTitle('')
    setIsAddingCard(false)
    router.invalidate()
  }

  const handleUpdateColumnName = async () => {
    if (columnName.trim() && columnName !== column.name) {
      await updateColumn({ data: { id: column.id, name: columnName } })
      router.invalidate()
    }
    setIsEditing(false)
  }

  const handleDeleteColumn = async () => {
    if (column.cards.length > 0 && !confirm(`Delete "${column.name}" and all ${column.cards.length} cards?`)) return
    await deleteColumn({ data: { id: column.id } })
    router.invalidate()
  }

  const handleDrop = async (position: number) => {
    if (!draggedCard) return
    await moveCard({ data: { cardId: draggedCard.cardId, targetColumnId: column.id, targetPosition: position } })
    setDraggedCard(null)
    setDropTarget(null)
    router.invalidate()
  }

  return (
    <div className="bg-gray-200 rounded-xl w-72 min-w-72 max-h-[calc(100vh-100px)] flex flex-col">
      <div className="p-3 flex justify-between items-center">
        {isEditing ? (
          <input
            type="text"
            value={columnName}
            onChange={(e) => setColumnName(e.target.value)}
            onBlur={handleUpdateColumnName}
            onKeyDown={(e) => e.key === 'Enter' && handleUpdateColumnName()}
            className="flex-1 px-2 py-1 border-2 border-sky-500 rounded text-sm"
            autoFocus
          />
        ) : (
          <span className="font-semibold text-sm text-gray-800 cursor-pointer" onClick={() => setIsEditing(true)}>
            {column.name}
          </span>
        )}
        <div className="flex items-center gap-1">
          <span className="bg-black/10 px-2 py-0.5 rounded-full text-xs text-gray-600">{column.cards.length}</span>
          <button className="p-1 hover:bg-black/10 rounded text-gray-500" onClick={handleDeleteColumn}>×</button>
        </div>
      </div>

      <div 
        className="px-2 pb-2 overflow-y-auto flex-1 flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault()
          if (draggedCard && column.cards.length === 0) setDropTarget(0)
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={() => dropTarget !== null && handleDrop(dropTarget)}
      >
        {column.cards.length === 0 && dropTarget === 0 && (
          <div className="min-h-[60px] border-2 border-dashed border-sky-500 bg-sky-500/20 rounded-lg" />
        )}
        
        {column.cards.map((card, index) => (
          <div key={card.id}>
            {dropTarget === index && draggedCard?.cardId !== card.id && (
              <div className="min-h-[60px] border-2 border-dashed border-sky-500 bg-sky-500/20 rounded-lg mb-2" />
            )}
            <Card
              card={card}
              onDragStart={() => setDraggedCard({ cardId: card.id, columnId: column.id })}
              onDragEnd={() => setDraggedCard(null)}
              onDragOver={() => setDropTarget(index)}
              onClick={() => onEditCard(card.id)}
              isDragging={draggedCard?.cardId === card.id}
            />
            {index === column.cards.length - 1 && dropTarget === index + 1 && (
              <div className="min-h-[60px] border-2 border-dashed border-sky-500 bg-sky-500/20 rounded-lg mt-2" />
            )}
          </div>
        ))}
      </div>

      <div className="p-2">
        {isAddingCard ? (
          <div>
            <textarea
              placeholder="Enter a title for this card..."
              value={newCardTitle}
              onChange={(e) => setNewCardTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm resize-none min-h-[60px] mb-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleAddCard()
                }
              }}
            />
            <div className="flex gap-2">
              <button onClick={handleAddCard} className="px-4 py-2 bg-sky-600 text-white rounded text-sm font-medium hover:bg-sky-700">
                Add Card
              </button>
              <button onClick={() => setIsAddingCard(false)} className="px-4 py-2 text-gray-500 text-sm hover:text-gray-700">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsAddingCard(true)}
            className="w-full py-2 px-3 text-left text-gray-500 hover:bg-black/5 rounded-lg text-sm transition-colors"
          >
            + Add a card
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Card Component
// ============================================================================

function Card({
  card,
  onDragStart,
  onDragEnd,
  onDragOver,
  onClick,
  isDragging,
}: {
  card: BoardType['columns'][0]['cards'][0]
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onClick: () => void
  isDragging: boolean
}) {
  const dueStatus = card.dueDate ? getDueStatus(new Date(card.dueDate)) : null

  return (
    <div
      className={`bg-white rounded-lg p-3 shadow-sm cursor-pointer hover:bg-gray-50 transition-all ${
        isDragging ? 'opacity-50 rotate-3' : ''
      }`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); onDragOver() }}
      onClick={onClick}
    >
      {card.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {card.labels.map(({ label }) => (
            <div key={label.id} className="h-2 w-10 rounded" style={{ background: label.color }} title={label.name} />
          ))}
        </div>
      )}
      <div className="text-sm text-gray-800 break-words">{card.title}</div>
      {(card.dueDate || card.description) && (
        <div className="flex gap-2 mt-2 text-xs text-gray-500">
          {card.dueDate && (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${
              dueStatus === 'overdue' ? 'bg-red-100 text-red-700' :
              dueStatus === 'soon' ? 'bg-yellow-100 text-yellow-700' :
              'bg-gray-100'
            }`}>
              📅 {formatDate(new Date(card.dueDate))}
            </span>
          )}
          {card.description && <span>📝</span>}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Add Column
// ============================================================================

function AddColumn({ boardId }: { boardId: string }) {
  const router = useRouter()
  const [isAdding, setIsAdding] = useState(false)
  const [name, setName] = useState('')

  const handleAdd = async () => {
    if (!name.trim()) return
    await createColumn({ data: { name, boardId } })
    setName('')
    setIsAdding(false)
    router.invalidate()
  }

  return (
    <div className="bg-white/25 rounded-xl w-72 min-w-72 p-3">
      {isAdding ? (
        <div>
          <input
            type="text"
            placeholder="Enter column name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded border-2 border-sky-500 text-sm mb-2 focus:outline-none"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <div className="flex gap-2">
            <button onClick={handleAdd} className="px-4 py-2 bg-sky-600 text-white rounded text-sm font-medium hover:bg-sky-700">
              Add Column
            </button>
            <button onClick={() => setIsAdding(false)} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setIsAdding(true)} className="w-full py-2 px-3 text-left text-white hover:bg-white/10 rounded-lg text-sm">
          + Add another column
        </button>
      )}
    </div>
  )
}

// ============================================================================
// Card Modal
// ============================================================================

function CardModal({
  cardId,
  board,
  onClose,
}: {
  cardId: string
  board: BoardType
  onClose: () => void
}) {
  const router = useRouter()
  
  const card = board.columns.flatMap(c => c.cards).find(c => c.id === cardId)
  if (!card) return null

  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description || '')
  const [dueDate, setDueDate] = useState(card.dueDate ? new Date(card.dueDate).toISOString().split('T')[0] : '')

  const cardLabelIds = new Set(card.labels.map(l => l.label.id))

  const handleSave = async () => {
    await updateCard({ data: { id: cardId, title, description: description || undefined, dueDate: dueDate || null } })
    router.invalidate()
    onClose()
  }

  const handleDelete = async () => {
    if (!confirm('Delete this card?')) return
    await deleteCard({ data: { id: cardId } })
    router.invalidate()
    onClose()
  }

  const handleToggleLabel = async (labelId: string) => {
    if (cardLabelIds.has(labelId)) {
      await removeLabelFromCard({ data: { cardId, labelId } })
    } else {
      await addLabelToCard({ data: { cardId, labelId } })
    }
    router.invalidate()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-12 px-4 overflow-y-auto z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-lg w-full max-w-3xl relative mb-12" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 text-2xl text-gray-500 hover:text-gray-700">×</button>
        
        <div className="p-4 border-b border-gray-200">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-xl font-semibold text-gray-900 bg-transparent border-none w-full focus:outline-none"
          />
        </div>

        <div className="p-4 space-y-4">
          <div>
            <h4 className="text-xs uppercase text-gray-500 font-medium mb-2">Labels</h4>
            <div className="flex flex-wrap gap-2">
              {board.labels.map(label => (
                <div
                  key={label.id}
                  onClick={() => handleToggleLabel(label.id)}
                  className={`px-3 py-1 rounded text-sm text-white cursor-pointer ${
                    cardLabelIds.has(label.id) ? 'ring-2 ring-gray-800' : ''
                  }`}
                  style={{ background: label.color }}
                >
                  {label.name}
                </div>
              ))}
              <CreateLabelButton boardId={board.id} userId={board.userId} />
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase text-gray-500 font-medium mb-2">Due Date</h4>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <div>
            <h4 className="text-xs uppercase text-gray-500 font-medium mb-2">Description</h4>
            <textarea
              placeholder="Add a more detailed description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded text-sm min-h-[100px] resize-y focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={handleSave} className="px-4 py-2 bg-sky-600 text-white rounded text-sm font-medium hover:bg-sky-700">
              Save
            </button>
            <button onClick={handleDelete} className="px-4 py-2 bg-red-500 text-white rounded text-sm font-medium hover:bg-red-600">
              Delete Card
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Create Label Button
// ============================================================================

function CreateLabelButton({ boardId, userId }: { boardId: string; userId: string }) {
  const router = useRouter()
  const [isCreating, setIsCreating] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(LABEL_COLORS[0])

  const handleCreate = async () => {
    if (!name.trim()) return
    await createLabel({ data: { name, color, boardId, userId } })
    setName('')
    setIsCreating(false)
    router.invalidate()
  }

  if (!isCreating) {
    return (
      <button 
        onClick={() => setIsCreating(true)}
        className="px-3 py-1 rounded text-sm bg-gray-300 text-gray-700 hover:bg-gray-400"
      >
        + New
      </button>
    )
  }

  return (
    <div className="flex gap-2 items-center">
      <input
        type="text"
        placeholder="Label name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-24 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
        autoFocus
      />
      <div className="flex gap-1">
        {LABEL_COLORS.map(c => (
          <div
            key={c}
            className={`w-6 h-6 rounded cursor-pointer ${c === color ? 'ring-2 ring-gray-800' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <button onClick={handleCreate} className="px-3 py-1 bg-sky-600 text-white rounded text-sm">Add</button>
      <button onClick={() => setIsCreating(false)} className="text-gray-500 hover:text-gray-700">×</button>
    </div>
  )
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getDueStatus(dueDate: Date): 'overdue' | 'soon' | '' {
  const now = new Date()
  const diff = dueDate.getTime() - now.getTime()
  const days = diff / (1000 * 60 * 60 * 24)
  
  if (days < 0) return 'overdue'
  if (days < 2) return 'soon'
  return ''
}
