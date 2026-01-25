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
    <div className="max-w-md mx-auto mt-16">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Form Builder</h1>
        <p className="text-gray-500 mt-2">Create custom forms with <strong>@shogo-ai/sdk</strong></p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          placeholder="Your email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {loading ? 'Setting up...' : 'Get Started'}
        </button>
      </form>

      <div className="mt-8 text-center text-xs text-gray-400">
        <p>Build custom forms with dynamic fields.</p>
        <p>For a simple pre-built form, see <strong>feedback-form</strong>.</p>
      </div>
    </div>
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
    <div>
      <header className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Your Forms</h1>
          <p className="text-gray-500">{user.name || user.email}</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          {showCreate ? 'Cancel' : '+ New Form'}
        </button>
      </header>

      {showCreate && (
        <form onSubmit={handleCreate} className="flex gap-2 mb-6">
          <input
            type="text"
            placeholder="Form name (e.g., Contact Form, Survey)"
            value={newFormName}
            onChange={(e) => setNewFormName(e.target.value)}
            autoFocus
            className="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={creating || !newFormName.trim()}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Form'}
          </button>
        </form>
      )}

      {forms.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p>No forms yet. Create your first form to get started!</p>
        </div>
      ) : (
        <div className="space-y-4">
          {forms.map((form) => (
            <div key={form.id} className="bg-gray-50 border border-gray-200 rounded-lg p-4 hover:border-blue-400 transition-colors">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Link to="/forms/$formId" params={{ formId: form.id }} className="font-semibold text-lg text-gray-900 hover:text-blue-600">
                      {form.name}
                    </Link>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      form.isPublished ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                    }`}>
                      {form.isPublished ? 'Published' : 'Draft'}
                    </span>
                  </div>
                  {form.description && (
                    <p className="text-gray-500 text-sm mb-1">{form.description}</p>
                  )}
                  <p className="text-xs text-gray-400">
                    {form._count?.submissions || 0} submissions · Created {new Date(form.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link to="/forms/$formId" params={{ formId: form.id }}>
                    <button className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors">
                      Edit
                    </button>
                  </Link>
                  {form.isPublished && (
                    <Link to="/f/$slug" params={{ slug: form.slug }}>
                      <button className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors">
                        View
                      </button>
                    </Link>
                  )}
                  <button
                    onClick={() => handleDelete(form.id)}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <footer className="mt-8 text-center text-sm text-gray-400">
        <p>All operations use <code className="bg-gray-100 px-1 rounded">shogo.db</code> (Prisma pass-through)</p>
      </footer>
    </div>
  )
}
