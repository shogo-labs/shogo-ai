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
import { useState, useRef } from 'react'
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
    // Load first board by default
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
    <div className="setup-container">
      <div className="setup-card">
        <h1>Kanban Board</h1>
        <p>Built with <strong>@shogo-ai/sdk</strong></p>

        <form onSubmit={handleSubmit} className="setup-form">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            required
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
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
    <div className="board-list">
      <h2>Your Boards</h2>
      <div className="board-grid">
        {boards.map(board => (
          <div 
            key={board.id}
            className="board-card"
            style={{ borderColor: board.color }}
            onClick={() => onSelectBoard(board.id)}
          >
            <h3>{board.name}</h3>
          </div>
        ))}
        
        {showForm ? (
          <div className="board-card" style={{ borderColor: '#dfe1e6' }}>
            <form onSubmit={handleCreateBoard}>
              <input
                type="text"
                placeholder="Board name"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                className="input"
                autoFocus
              />
              <div className="form-actions" style={{ marginTop: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={loading}>
                  Create
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="board-card new-board-card" onClick={() => setShowForm(true)}>
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
    <div>
      <header className="header" style={{ background: board.color }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-icon" onClick={onBack} style={{ color: 'white' }}>
            ←
          </button>
          <h1>{board.name}</h1>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost" style={{ color: 'white' }} onClick={handleDeleteBoard}>
            Delete Board
          </button>
        </div>
      </header>

      <div className="board-container" style={{ background: board.color }}>
        <div className="columns-wrapper">
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
    await createCard({ 
      data: { 
        title: newCardTitle, 
        columnId: column.id, 
        userId: user.id 
      } 
    })
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
    if (column.cards.length > 0) {
      if (!confirm(`Delete "${column.name}" and all ${column.cards.length} cards?`)) return
    }
    await deleteColumn({ data: { id: column.id } })
    router.invalidate()
  }

  const handleDrop = async (position: number) => {
    if (!draggedCard) return
    await moveCard({ 
      data: { 
        cardId: draggedCard.cardId, 
        targetColumnId: column.id, 
        targetPosition: position 
      } 
    })
    setDraggedCard(null)
    setDropTarget(null)
    router.invalidate()
  }

  return (
    <div className="column">
      <div className="column-header">
        {isEditing ? (
          <input
            type="text"
            value={columnName}
            onChange={(e) => setColumnName(e.target.value)}
            onBlur={handleUpdateColumnName}
            onKeyDown={(e) => e.key === 'Enter' && handleUpdateColumnName()}
            className="column-input"
            autoFocus
          />
        ) : (
          <span className="column-title" onClick={() => setIsEditing(true)}>
            {column.name}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="column-count">{column.cards.length}</span>
          <button className="btn-icon" onClick={handleDeleteColumn}>×</button>
        </div>
      </div>

      <div 
        className="column-cards"
        onDragOver={(e) => {
          e.preventDefault()
          if (draggedCard && column.cards.length === 0) {
            setDropTarget(0)
          }
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={() => dropTarget !== null && handleDrop(dropTarget)}
      >
        {column.cards.length === 0 && dropTarget === 0 && (
          <div className="drop-zone active" />
        )}
        
        {column.cards.map((card, index) => (
          <div key={card.id}>
            {dropTarget === index && draggedCard?.cardId !== card.id && (
              <div className="drop-zone active" />
            )}
            <Card
              card={card}
              columnId={column.id}
              onDragStart={() => setDraggedCard({ cardId: card.id, columnId: column.id })}
              onDragEnd={() => setDraggedCard(null)}
              onDragOver={() => setDropTarget(index)}
              onClick={() => onEditCard(card.id)}
              isDragging={draggedCard?.cardId === card.id}
            />
            {index === column.cards.length - 1 && dropTarget === index + 1 && (
              <div className="drop-zone active" />
            )}
          </div>
        ))}
      </div>

      <div className="add-card-form">
        {isAddingCard ? (
          <div>
            <textarea
              placeholder="Enter a title for this card..."
              value={newCardTitle}
              onChange={(e) => setNewCardTitle(e.target.value)}
              className="card-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleAddCard()
                }
              }}
            />
            <div className="form-actions">
              <button className="btn btn-primary" onClick={handleAddCard}>
                Add Card
              </button>
              <button className="btn btn-secondary" onClick={() => setIsAddingCard(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="add-card-btn" onClick={() => setIsAddingCard(true)}>
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
  columnId,
  onDragStart,
  onDragEnd,
  onDragOver,
  onClick,
  isDragging,
}: {
  card: BoardType['columns'][0]['cards'][0]
  columnId: string
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onClick: () => void
  isDragging: boolean
}) {
  const dueStatus = card.dueDate ? getDueStatus(new Date(card.dueDate)) : null

  return (
    <div
      className={`card ${isDragging ? 'dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver()
      }}
      onClick={onClick}
    >
      {card.labels.length > 0 && (
        <div className="card-labels">
          {card.labels.map(({ label }) => (
            <div
              key={label.id}
              className="card-label"
              style={{ background: label.color }}
              title={label.name}
            />
          ))}
        </div>
      )}
      <div className="card-title">{card.title}</div>
      {(card.dueDate || card.description) && (
        <div className="card-meta">
          {card.dueDate && (
            <span className={`card-due ${dueStatus}`}>
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
    <div className="add-column">
      {isAdding ? (
        <div>
          <input
            type="text"
            placeholder="Enter column name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="column-input"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <div className="form-actions">
            <button className="btn btn-primary" onClick={handleAdd}>
              Add Column
            </button>
            <button className="btn btn-secondary" onClick={() => setIsAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="add-column-btn" onClick={() => setIsAdding(true)}>
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
  
  // Find card in board data
  const card = board.columns
    .flatMap(c => c.cards)
    .find(c => c.id === cardId)
  
  if (!card) return null

  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description || '')
  const [dueDate, setDueDate] = useState(
    card.dueDate ? new Date(card.dueDate).toISOString().split('T')[0] : ''
  )

  const cardLabelIds = new Set(card.labels.map(l => l.label.id))

  const handleSave = async () => {
    await updateCard({
      data: {
        id: cardId,
        title,
        description: description || undefined,
        dueDate: dueDate || null,
      }
    })
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        
        <div className="modal-header">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="modal-input"
            style={{ fontSize: '1.25rem', fontWeight: 600, border: 'none', padding: 0 }}
          />
        </div>

        <div className="modal-body">
          <div className="modal-section">
            <h4>Labels</h4>
            <div className="labels-list">
              {board.labels.map(label => (
                <div
                  key={label.id}
                  className={`label-chip ${cardLabelIds.has(label.id) ? 'selected' : ''}`}
                  style={{ background: label.color }}
                  onClick={() => handleToggleLabel(label.id)}
                >
                  {label.name}
                </div>
              ))}
              <CreateLabelButton boardId={board.id} userId={board.userId} />
            </div>
          </div>

          <div className="modal-section">
            <h4>Due Date</h4>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="modal-input"
            />
          </div>

          <div className="modal-section">
            <h4>Description</h4>
            <textarea
              placeholder="Add a more detailed description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="modal-input"
            />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={handleSave}>
              Save
            </button>
            <button className="btn btn-danger" onClick={handleDelete}>
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
        className="label-chip" 
        style={{ background: '#dfe1e6', color: '#172b4d' }}
        onClick={() => setIsCreating(true)}
      >
        + New
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="text"
        placeholder="Label name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="modal-input"
        style={{ width: 100 }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 4 }}>
        {LABEL_COLORS.map(c => (
          <div
            key={c}
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              background: c,
              cursor: 'pointer',
              border: c === color ? '2px solid #172b4d' : '2px solid transparent',
            }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <button className="btn btn-primary" onClick={handleCreate}>Add</button>
      <button className="btn btn-secondary" onClick={() => setIsCreating(false)}>×</button>
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
