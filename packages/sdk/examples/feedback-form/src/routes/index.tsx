/**
 * Feedback Form - Dashboard & Submissions List
 * 
 * Demonstrates the SDK's Prisma pass-through:
 * - shogo.db.submission.findMany() for listing
 * - shogo.db.submission.update() for marking read/starred
 * - Aggregations for statistics
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { 
  getSubmissions, 
  getStats, 
  markAsRead, 
  toggleStar, 
  deleteSubmission,
  type SubmissionType,
  type SubmissionStats 
} from '../utils/submissions'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { submissions: [] as SubmissionType[], stats: null }
    }

    const [submissions, stats] = await Promise.all([
      getSubmissions({ data: { userId: context.user.id } }),
      getStats({ data: { userId: context.user.id } }),
    ])
    return { submissions, stats }
  },
  component: FeedbackDashboard,
})

function FeedbackDashboard() {
  const { user } = Route.useRouteContext()
  const { submissions, stats } = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return <Dashboard user={user} submissions={submissions} stats={stats} />
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
        <h1 className="text-2xl font-bold text-gray-900">Feedback Form</h1>
        <p className="text-gray-500 mt-2">Collect customer feedback with <strong>@shogo-ai/sdk</strong></p>
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
          {loading ? 'Setting up...' : 'Create Your Form'}
        </button>
      </form>

      <div className="mt-8 text-center text-xs text-gray-400">
        <p>This is a pre-built feedback form template.</p>
        <p>For building custom forms, see the <strong>form-builder</strong> template.</p>
      </div>
    </div>
  )
}

function Dashboard({ 
  user, 
  submissions, 
  stats 
}: { 
  user: UserType
  submissions: SubmissionType[]
  stats: SubmissionStats | null
}) {
  const router = useRouter()
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all')

  const filteredSubmissions = submissions.filter(s => {
    if (filter === 'unread') return !s.isRead
    if (filter === 'starred') return s.isStarred
    return true
  })

  const handleMarkRead = async (id: string, isRead: boolean) => {
    await markAsRead({ data: { id, userId: user.id, isRead } })
    router.invalidate()
  }

  const handleToggleStar = async (id: string, isStarred: boolean) => {
    await toggleStar({ data: { id, userId: user.id, isStarred } })
    router.invalidate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this submission?')) return
    await deleteSubmission({ data: { id, userId: user.id } })
    router.invalidate()
  }

  const formUrl = typeof window !== 'undefined' 
    ? `${window.location.origin}/form/${user.id}`
    : `/form/${user.id}`

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Feedback Dashboard</h1>
        <p className="text-gray-500">{user.name || user.email}</p>
        
        {/* Share form link */}
        <div className="bg-blue-50 p-4 rounded-lg mt-4">
          <p className="font-medium text-gray-900 mb-2">Share your feedback form:</p>
          <div className="flex gap-2">
            <input 
              type="text" 
              value={formUrl} 
              readOnly 
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            />
            <button 
              onClick={() => navigator.clipboard.writeText(formUrl)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              Copy
            </button>
            <Link to="/form/$userId" params={{ userId: user.id }}>
              <button className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">
                Preview
              </button>
            </Link>
          </div>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.total}</p>
            <p className="text-sm text-gray-500">Total</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.unread}</p>
            <p className="text-sm text-gray-500">Unread</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.averageRating}</p>
            <p className="text-sm text-gray-500">Avg Rating</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.recommendRate}%</p>
            <p className="text-sm text-gray-500">Would Recommend</p>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        {(['all', 'unread', 'starred'] as const).map((f) => (
          <button 
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === f 
                ? 'bg-blue-600 text-white' 
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)} ({
              f === 'all' ? submissions.length :
              f === 'unread' ? submissions.filter(s => !s.isRead).length :
              submissions.filter(s => s.isStarred).length
            })
          </button>
        ))}
      </div>

      {/* Submissions list */}
      {filteredSubmissions.length === 0 ? (
        <p className="text-center text-gray-400 py-8">
          {submissions.length === 0 
            ? 'No submissions yet. Share your form link to start collecting feedback!'
            : 'No submissions match the current filter.'}
        </p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          {filteredSubmissions.map((submission) => (
            <div 
              key={submission.id} 
              className={`flex items-start gap-4 p-4 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors ${
                !submission.isRead ? 'bg-blue-50 hover:bg-blue-100' : ''
              }`}
            >
              {/* Star button */}
              <button
                onClick={() => handleToggleStar(submission.id, !submission.isStarred)}
                className={`text-xl ${submission.isStarred ? 'text-yellow-400' : 'text-gray-300'} hover:text-yellow-500`}
              >
                ★
              </button>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <strong className="text-gray-900">{submission.name}</strong>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    submission.category === 'feedback' ? 'bg-blue-100 text-blue-800' :
                    submission.category === 'bug' ? 'bg-red-100 text-red-800' :
                    submission.category === 'feature' ? 'bg-green-100 text-green-800' :
                    'bg-yellow-100 text-yellow-800'
                  }`}>
                    {submission.category}
                  </span>
                  <span className="text-gray-400 text-sm">
                    {'★'.repeat(submission.rating)}{'☆'.repeat(5 - submission.rating)}
                  </span>
                </div>
                <p className="text-gray-600 text-sm mb-1 line-clamp-2">
                  {submission.message}
                </p>
                <p className="text-xs text-gray-400">
                  {submission.email} · {new Date(submission.createdAt).toLocaleDateString()}
                  {submission.wouldRecommend && ' · Would recommend'}
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleMarkRead(submission.id, !submission.isRead)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-100"
                >
                  {submission.isRead ? 'Mark Unread' : 'Mark Read'}
                </button>
                <button
                  onClick={() => handleDelete(submission.id)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-100"
                >
                  Delete
                </button>
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
