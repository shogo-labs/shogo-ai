# Kanban Board - Shogo SDK Example

A project management board demonstrating the **@shogo-ai/sdk** with position/ordering patterns and drag-and-drop.

## Key Concept: Position Ordering

Cards and columns use a `position` field for ordering. When items are reordered or moved between columns, positions are recalculated:

```typescript
// Move a card to a new column and position
export async function moveCard(args: {
  data: { cardId: string; targetColumnId: string; targetPosition: number }
}) {
  const { cardId, targetColumnId, targetPosition } = args.data

  // Shift cards in target column to make room
  await shogo.db.card.updateMany({
    where: {
      columnId: targetColumnId,
      position: { gte: targetPosition }
    },
    data: { position: { increment: 1 } }
  })

  // Move the card
  await shogo.db.card.update({
    where: { id: cardId },
    data: { columnId: targetColumnId, position: targetPosition }
  })
}
```

## Features

- **Boards** - Multiple boards per user with custom colors
- **Columns** - Orderable columns (To Do, In Progress, Done, etc.)
- **Cards** - Draggable cards with titles, descriptions, due dates
- **Labels** - Color-coded labels with many-to-many card relationships
- **Position Ordering** - Efficient reordering with position field pattern

## Getting Started

1. Install dependencies:
   ```bash
   bun install
   ```

2. Set up the database:
   ```bash
   bun run db:push
   ```

3. Start the development server:
   ```bash
   bun run dev
   ```

4. Open [http://localhost:3003](http://localhost:3003)

## Project Structure

```
kanban/
├── prisma/
│   └── schema.prisma      # Board, Column, Card, Label, CardLabel models
├── src/
│   ├── lib/
│   │   └── shogo.ts       # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx     # Root layout with Kanban styles
│   │   └── index.tsx      # Main board UI with drag-drop
│   └── utils/
│       ├── db.ts          # Prisma client
│       ├── user.ts        # User operations via shogo.db
│       ├── boards.ts      # Board CRUD with nested includes
│       ├── columns.ts     # Column CRUD with position ordering
│       ├── cards.ts       # Card CRUD with move/reorder logic
│       └── labels.ts      # Label CRUD
├── package.json
└── vite.config.ts
```

## SDK Usage Examples

### Nested Includes

```typescript
// Get board with all columns, cards, and labels in one query
const board = await shogo.db.board.findFirst({
  where: { id: boardId, userId },
  include: {
    columns: {
      orderBy: { position: 'asc' },
      include: {
        cards: {
          orderBy: { position: 'asc' },
          include: {
            labels: { include: { label: true } }
          }
        }
      }
    },
    labels: { orderBy: { name: 'asc' } }
  }
})
```

### Position Updates

```typescript
// Add card at end of column
const maxPos = await shogo.db.card.aggregate({
  where: { columnId },
  _max: { position: true }
})

await shogo.db.card.create({
  data: {
    title,
    columnId,
    userId,
    position: (maxPos._max.position ?? -1) + 1
  }
})
```

### Many-to-Many Labels

```typescript
// Add label to card
await shogo.db.cardLabel.create({
  data: { cardId, labelId }
})

// Remove label from card
await shogo.db.cardLabel.delete({
  where: {
    cardId_labelId: { cardId, labelId }
  }
})
```

### Batch Position Updates

```typescript
// Reorder columns
await Promise.all(
  columnIds.map((id, index) =>
    shogo.db.column.update({
      where: { id },
      data: { position: index }
    })
  )
)
```

## Data Model

```
User
 └── Board (one-to-many)
      ├── Column (one-to-many, ordered by position)
      │    └── Card (one-to-many, ordered by position)
      │         └── CardLabel (many-to-many junction)
      │              └── Label
      └── Label (one-to-many)
```

## Why Position Ordering?

1. **Efficient reordering** - Only update affected positions, not all items
2. **Predictable order** - Integer positions are fast to sort and compare
3. **Gap-tolerant** - Works even if positions have gaps (0, 2, 5, etc.)
4. **Batch-friendly** - Can update multiple positions in parallel
