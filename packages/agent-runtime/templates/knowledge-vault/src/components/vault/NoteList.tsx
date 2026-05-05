import { NoteCard } from './NoteCard'
import type { Note } from './types'

interface NoteListProps {
  notes: Note[]
}

export function NoteList({ notes }: NoteListProps) {
  if (notes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="text-4xl mb-3">📭</div>
        <h3 className="text-sm font-medium text-zinc-300">No notes yet</h3>
        <p className="text-xs text-zinc-500 mt-1 max-w-sm">
          Send me a URL, PDF, voice memo, or any text and I'll extract entities,
          claims, and decisions into your vault.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {notes.map(note => (
        <NoteCard key={note.id} note={note} />
      ))}
    </div>
  )
}
