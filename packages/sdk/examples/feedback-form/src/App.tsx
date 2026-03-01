/**
 * Feedback Form App
 *
 * Uses Hono API routes and MobX for state management.
 * Supports both authenticated dashboard and public form pages.
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  LogOut, Copy, ExternalLink, Star, Mail, Trash2, Eye, EyeOff,
  Loader2, MessageSquare, Send, CheckCircle2, AlertCircle, Inbox,
} from 'lucide-react'

interface SubmissionType {
  id: string
  name: string
  email: string
  rating: number
  category: string
  message: string
  wouldRecommend: boolean
  isRead: boolean
  isStarred: boolean
  userId: string
  createdAt: string
  updatedAt: string
}

interface SubmissionStats {
  total: number
  unread: number
  starred: number
  averageRating: number
  recommendRate: number
}

interface User {
  id: string
  email: string
  name: string | null
}

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const handleHash = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  if (route.startsWith('/form/')) {
    const userId = route.replace('/form/', '')
    return <PublicFormPage userId={userId} />
  }

  return (
    <AuthGate>
      <DashboardPage />
    </AuthGate>
  )
}

// =============================================================================
// Dashboard
// =============================================================================

const DashboardPage = observer(function DashboardPage() {
  const { auth } = useStores()
  const [submissions, setSubmissions] = useState<SubmissionType[]>([])
  const [stats, setStats] = useState<SubmissionStats | null>(null)
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const fetchData = useCallback(async () => {
    if (!auth.user) return

    try {
      const [subsRes, statsRes] = await Promise.all([
        api.submission.list(),
        fetch(`/api/submissions/stats?userId=${auth.user.id}`),
      ])

      if (subsRes.ok) {
        setSubmissions((subsRes.items || []) as any)
      }
      if (statsRes.ok) {
        setStats(await statsRes.json())
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleMarkRead = async (id: string, isRead: boolean) => {
    await api.submission.update(id, { isRead } as any)
    fetchData()
  }

  const handleToggleStar = async (id: string, isStarred: boolean) => {
    await api.submission.update(id, { isStarred } as any)
    fetchData()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this submission?')) return
    await api.submission.delete(id)
    fetchData()
  }

  const filteredSubmissions = submissions.filter((s) => {
    if (filter === 'unread') return !s.isRead
    if (filter === 'starred') return s.isStarred
    return true
  })

  const formUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/#/form/${auth.user?.id}`
    : `/#/form/${auth.user?.id}`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(formUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const filterCounts = {
    all: submissions.length,
    unread: submissions.filter((s) => !s.isRead).length,
    starred: submissions.filter((s) => s.isStarred).length,
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Feedback Dashboard</h1>
            <p className="text-sm text-muted-foreground">{auth.user?.name || auth.user?.email}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => auth.signOut()}>
            <LogOut className="size-4" />
            Sign Out
          </Button>
        </div>

        {/* Share link */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <p className="text-sm font-medium mb-2">Share your feedback form:</p>
            <div className="flex gap-2">
              <Input value={formUrl} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => (window.location.hash = `/form/${auth.user?.id}`)}
              >
                <ExternalLink className="size-4" />
                Preview
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
            <StatCard label="Total" value={stats.total} />
            <StatCard label="Unread" value={stats.unread} />
            <StatCard label="Avg Rating" value={stats.averageRating} />
            <StatCard label="Would Recommend" value={`${stats.recommendRate}%`} />
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-1 mb-4">
          {(['all', 'unread', 'starred'] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)} ({filterCounts[f]})
            </Button>
          ))}
        </div>

        {/* Submissions */}
        {filteredSubmissions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
            <Inbox className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              {submissions.length === 0
                ? 'No submissions yet. Share your form link to start collecting feedback!'
                : 'No submissions match the current filter.'}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden divide-y">
            {filteredSubmissions.map((submission) => (
              <SubmissionRow
                key={submission.id}
                submission={submission}
                onMarkRead={handleMarkRead}
                onToggleStar={handleToggleStar}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-muted-foreground">
          Built with <span className="font-medium">@shogo-ai/sdk</span> + Hono
        </p>
      </div>
    </div>
  )
})

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-6 text-center">
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </CardContent>
    </Card>
  )
}

const CATEGORY_STYLES: Record<string, string> = {
  feedback: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  bug: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  feature: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  question: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
}

function SubmissionRow({
  submission,
  onMarkRead,
  onToggleStar,
  onDelete,
}: {
  submission: SubmissionType
  onMarkRead: (id: string, isRead: boolean) => void
  onToggleStar: (id: string, isStarred: boolean) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className={`flex items-start gap-3 p-4 ${!submission.isRead ? 'bg-accent/50' : ''}`}>
      <Button
        variant="ghost"
        size="icon-xs"
        className="mt-0.5 shrink-0"
        onClick={() => onToggleStar(submission.id, !submission.isStarred)}
      >
        <Star
          className={`size-4 ${submission.isStarred ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}`}
        />
      </Button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-medium text-sm">{submission.name}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CATEGORY_STYLES[submission.category] || CATEGORY_STYLES.question}`}
          >
            {submission.category}
          </span>
          <span className="text-xs text-amber-500">
            {'★'.repeat(submission.rating)}
            <span className="text-muted-foreground/30">{'★'.repeat(5 - submission.rating)}</span>
          </span>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2 mb-1">{submission.message}</p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Mail className="size-3" />
          <span>{submission.email}</span>
          <span>·</span>
          <span>{new Date(submission.createdAt).toLocaleDateString()}</span>
          {submission.wouldRecommend && (
            <>
              <span>·</span>
              <Badge variant="secondary" className="text-[10px] py-0 h-4">Would recommend</Badge>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onMarkRead(submission.id, !submission.isRead)}
          title={submission.isRead ? 'Mark unread' : 'Mark read'}
        >
          {submission.isRead ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onDelete(submission.id)}
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// Public Form
// =============================================================================

function PublicFormPage({ userId }: { userId: string }) {
  const [formOwner, setFormOwner] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((res) => {
        if (!res.ok) {
          setNotFound(true)
          return null
        }
        return res.json()
      })
      .then((user) => {
        if (user) setFormOwner(user)
      })
      .finally(() => setLoading(false))
  }, [userId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (notFound || !formOwner) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Form Not Found</CardTitle>
            <CardDescription>This feedback form doesn't exist or has been removed.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => (window.location.hash = '/')}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <FeedbackForm userId={userId} ownerName={formOwner.name || formOwner.email} />
}

function FeedbackForm({ userId, ownerName }: { userId: string; ownerName: string }) {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [rating, setRating] = useState(0)
  const [category, setCategory] = useState('feedback')
  const [message, setMessage] = useState('')
  const [wouldRecommend, setWouldRecommend] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !email || !rating || !message) {
      setError('Please fill in all required fields')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name, email, rating, category, message, wouldRecommend }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to submit feedback')
      }

      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit feedback')
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setSubmitted(false)
    setName('')
    setEmail('')
    setRating(0)
    setCategory('feedback')
    setMessage('')
    setWouldRecommend(false)
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400">
              <CheckCircle2 className="size-6" />
            </div>
            <CardTitle>Thank You!</CardTitle>
            <CardDescription>Your feedback has been submitted successfully.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={resetForm}>Submit Another Response</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageSquare className="size-5" />
          </div>
          <CardTitle>Share Your Feedback</CardTitle>
          <CardDescription>for {ownerName}</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="form-name">Your Name *</Label>
              <Input
                id="form-name"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="form-email">Your Email *</Label>
              <Input
                id="form-email"
                type="email"
                placeholder="john@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Rating *</Label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    className={`text-2xl transition-colors cursor-pointer ${
                      rating >= star
                        ? 'text-amber-400'
                        : 'text-muted-foreground/30 hover:text-amber-300'
                    }`}
                    onClick={() => setRating(star)}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="form-category">Category</Label>
              <select
                id="form-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
              >
                <option value="feedback">General Feedback</option>
                <option value="bug">Bug Report</option>
                <option value="feature">Feature Request</option>
                <option value="question">Question</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="form-message">Your Message *</Label>
              <textarea
                id="form-message"
                placeholder="Tell us what you think..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                required
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none resize-none"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={wouldRecommend}
                onChange={(e) => setWouldRecommend(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Would you recommend us to others?
            </label>

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {loading ? 'Submitting...' : 'Submit Feedback'}
            </Button>
          </form>
        </CardContent>

        <div className="px-6 pb-6 text-center">
          <p className="text-xs text-muted-foreground">Powered by Shogo SDK</p>
          <Button
            variant="link"
            size="sm"
            className="h-auto mt-1 p-0 text-xs"
            onClick={() => (window.location.hash = '/')}
          >
            Back to Dashboard
          </Button>
        </div>
      </Card>
    </div>
  )
}
