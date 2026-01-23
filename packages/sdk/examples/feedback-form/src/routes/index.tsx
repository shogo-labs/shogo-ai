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
    <article style={{ maxWidth: '400px', margin: '4rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Feedback Form</h1>
        <p>Collect customer feedback with <strong>@shogo-ai/sdk</strong></p>
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
          {loading ? 'Setting up...' : 'Create Your Form'}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>This is a pre-built feedback form template.</p>
        <p>For building custom forms, see the <strong>form-builder</strong> template.</p>
      </footer>
    </article>
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
    <article>
      <header style={{ marginBottom: '2rem' }}>
        <h1>Feedback Dashboard</h1>
        <p style={{ color: '#666' }}>{user.name || user.email}</p>
        
        {/* Share form link */}
        <div style={{ 
          background: '#f0f9ff', 
          padding: '1rem', 
          borderRadius: '0.5rem',
          marginTop: '1rem'
        }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 500 }}>Share your feedback form:</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input 
              type="text" 
              value={formUrl} 
              readOnly 
              style={{ flex: 1, marginBottom: 0 }}
            />
            <button 
              onClick={() => navigator.clipboard.writeText(formUrl)}
              style={{ marginBottom: 0 }}
            >
              Copy
            </button>
            <Link to="/form/$userId" params={{ userId: user.id }}>
              <button className="outline" style={{ marginBottom: 0 }}>Preview</button>
            </Link>
          </div>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', 
          gap: '1rem',
          marginBottom: '2rem'
        }}>
          <div className="stat-card">
            <h3>{stats.total}</h3>
            <p>Total</p>
          </div>
          <div className="stat-card">
            <h3>{stats.unread}</h3>
            <p>Unread</p>
          </div>
          <div className="stat-card">
            <h3>{stats.averageRating}</h3>
            <p>Avg Rating</p>
          </div>
          <div className="stat-card">
            <h3>{stats.recommendRate}%</h3>
            <p>Would Recommend</p>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="filter-tabs">
        <button 
          className={filter === 'all' ? 'active' : ''} 
          onClick={() => setFilter('all')}
        >
          All ({submissions.length})
        </button>
        <button 
          className={filter === 'unread' ? 'active' : ''} 
          onClick={() => setFilter('unread')}
        >
          Unread ({submissions.filter(s => !s.isRead).length})
        </button>
        <button 
          className={filter === 'starred' ? 'active' : ''} 
          onClick={() => setFilter('starred')}
        >
          Starred ({submissions.filter(s => s.isStarred).length})
        </button>
      </div>

      {/* Submissions list */}
      {filteredSubmissions.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#666', padding: '2rem' }}>
          {submissions.length === 0 
            ? 'No submissions yet. Share your form link to start collecting feedback!'
            : 'No submissions match the current filter.'}
        </p>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '0.5rem' }}>
          {filteredSubmissions.map((submission) => (
            <div 
              key={submission.id} 
              className={`submission-item ${!submission.isRead ? 'unread' : ''}`}
            >
              {/* Star button */}
              <button
                onClick={() => handleToggleStar(submission.id, !submission.isStarred)}
                style={{ 
                  background: 'none', 
                  border: 'none', 
                  cursor: 'pointer',
                  fontSize: '1.25rem',
                  color: submission.isStarred ? '#fbbf24' : '#d1d5db'
                }}
              >
                ★
              </button>

              {/* Content */}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <strong>{submission.name}</strong>
                  <span className={`category-badge ${submission.category}`}>
                    {submission.category}
                  </span>
                  <span style={{ color: '#9ca3af', fontSize: '0.875rem' }}>
                    {'★'.repeat(submission.rating)}{'☆'.repeat(5 - submission.rating)}
                  </span>
                </div>
                <p style={{ margin: '0.25rem 0', color: '#4b5563' }}>
                  {submission.message.length > 100 
                    ? submission.message.slice(0, 100) + '...' 
                    : submission.message}
                </p>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#9ca3af' }}>
                  {submission.email} · {new Date(submission.createdAt).toLocaleDateString()}
                  {submission.wouldRecommend && ' · Would recommend'}
                </p>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="outline secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => handleMarkRead(submission.id, !submission.isRead)}
                >
                  {submission.isRead ? 'Mark Unread' : 'Mark Read'}
                </button>
                <button
                  className="outline secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => handleDelete(submission.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.875rem', color: '#666' }}>
        <p>
          All operations use <code>shogo.db</code> (Prisma pass-through)
        </p>
      </footer>
    </article>
  )
}
