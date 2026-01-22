/**
 * Form Builder - Dashboard
 * 
 * Lists all forms created by the user.
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getForms, createForm, deleteForm, type FormType } from '../utils/forms'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { forms: [] as FormType[] }
    }
    const forms = await getForms({ data: { userId: context.user.id } })
    return { forms }
  },
  component: Dashboard,
})

function Dashboard() {
  const { user } = Route.useRouteContext()
  const { forms } = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return <FormsList user={user} forms={forms} />
}

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
    <article style={{ maxWidth: '400px', margin: '4rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Form Builder</h1>
        <p>Create custom forms with <strong>@shogo-ai/sdk</strong></p>
      </header>

      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Your email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <p style={{ color: '#e00', fontSize: '0.875rem' }}>{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? 'Setting up...' : 'Get Started'}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>Build custom forms with dynamic fields.</p>
        <p>For a simple pre-built form, see <strong>feedback-form</strong>.</p>
      </footer>
    </article>
  )
}

function FormsList({ user, forms }: { user: UserType; forms: FormType[] }) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)
  const [newFormName, setNewFormName] = useState('')
  const [creating, setCreating] = useState(false)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newFormName.trim()) return

    setCreating(true)
    try {
      await createForm({ data: { userId: user.id, name: newFormName.trim() } })
      setNewFormName('')
      setShowCreate(false)
      router.invalidate()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create form')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this form and all its submissions?')) return
    await deleteForm({ data: { id, userId: user.id } })
    router.invalidate()
  }

  return (
    <article>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.25rem' }}>Your Forms</h1>
          <p style={{ color: '#666', margin: 0 }}>{user.name || user.email}</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Form'}
        </button>
      </header>

      {showCreate && (
        <form onSubmit={handleCreate} style={{ marginBottom: '1.5rem' }} role="group">
          <input
            type="text"
            placeholder="Form name (e.g., Contact Form, Survey)"
            value={newFormName}
            onChange={(e) => setNewFormName(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={creating || !newFormName.trim()}>
            {creating ? 'Creating...' : 'Create Form'}
          </button>
        </form>
      )}

      {forms.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
          <p>No forms yet. Create your first form to get started!</p>
        </div>
      ) : (
        <div>
          {forms.map((form) => (
            <div key={form.id} className="form-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <Link to="/forms/$formId" params={{ formId: form.id }} style={{ fontWeight: 600, fontSize: '1.1rem' }}>
                      {form.name}
                    </Link>
                    <span className={`status-badge ${form.isPublished ? 'published' : 'draft'}`}>
                      {form.isPublished ? 'Published' : 'Draft'}
                    </span>
                  </div>
                  {form.description && (
                    <p style={{ color: '#666', fontSize: '0.875rem', margin: '0.25rem 0' }}>
                      {form.description}
                    </p>
                  )}
                  <p style={{ color: '#9ca3af', fontSize: '0.75rem', margin: '0.5rem 0 0' }}>
                    {form._count?.submissions || 0} submissions · Created {new Date(form.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Link to="/forms/$formId" params={{ formId: form.id }}>
                    <button className="outline" style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }}>
                      Edit
                    </button>
                  </Link>
                  {form.isPublished && (
                    <Link to="/f/$slug" params={{ slug: form.slug }}>
                      <button className="outline secondary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }}>
                        View
                      </button>
                    </Link>
                  )}
                  <button
                    className="outline secondary"
                    style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }}
                    onClick={() => handleDelete(form.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.875rem', color: '#666' }}>
        <p>All operations use <code>shogo.db</code> (Prisma pass-through)</p>
      </footer>
    </article>
  )
}
