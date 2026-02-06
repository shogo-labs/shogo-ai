/**
 * AdminUserDetail - Detailed view of a single user with their workspaces and activity.
 */

import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Shield, User, Building2, MessageSquare, Loader2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useAdminUser, adminUpdateUser, adminDeleteUser } from '../hooks/useAdminApi'

export function AdminUserDetail() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const { data: user, loading, refetch } = useAdminUser(userId!)

  const handleToggleRole = async () => {
    if (!user) return
    const newRole = user.role === 'super_admin' ? 'user' : 'super_admin'
    const result = await adminUpdateUser(user.id, { role: newRole })
    if (result.ok) refetch()
  }

  const handleDelete = async () => {
    if (!user) return
    if (!confirm(`Are you sure you want to delete ${user.email}? This action cannot be undone.`)) return
    const result = await adminDeleteUser(user.id)
    if (result.ok) navigate('/admin/users')
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">User not found.</p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Back Link */}
      <Link to="/admin/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" />
        Back to Users
      </Link>

      {/* User Header */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
              {user.image ? (
                <img src={user.image} alt="" className="h-14 w-14 rounded-full" />
              ) : (
                <span className="text-lg font-semibold text-primary">
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <div>
              <h2 className="text-lg font-bold">{user.name || 'Unnamed'}</h2>
              <p className="text-sm text-muted-foreground">{user.email}</p>
              <div className="flex items-center gap-2 mt-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                    user.role === 'super_admin'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {user.role === 'super_admin' ? <Shield className="h-3 w-3" /> : <User className="h-3 w-3" />}
                  {user.role === 'super_admin' ? 'Super Admin' : 'User'}
                </span>
                {user.emailVerified && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    Verified
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleToggleRole}>
              {user.role === 'super_admin' ? 'Remove Admin' : 'Make Admin'}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mt-6 pt-4 border-t border-border">
          <div>
            <span className="text-xs text-muted-foreground">Joined</span>
            <p className="text-sm font-medium">{new Date(user.createdAt).toLocaleDateString()}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Last Updated</span>
            <p className="text-sm font-medium">{new Date(user.updatedAt).toLocaleDateString()}</p>
          </div>
        </div>
      </div>

      {/* Workspace Memberships */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-4">
          <Building2 className="h-4 w-4" />
          Workspace Memberships ({user.members?.length ?? 0})
        </h3>
        {!user.members?.length ? (
          <p className="text-sm text-muted-foreground">No workspaces</p>
        ) : (
          <div className="space-y-2">
            {user.members.map((m) => (
              <div key={m.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                <Link
                  to={`/admin/workspaces/${m.workspaceId}`}
                  className="text-sm font-medium hover:text-primary transition-colors"
                >
                  Workspace {m.workspaceId.slice(0, 8)}...
                </Link>
                <span className="text-xs font-medium text-muted-foreground capitalize">
                  {m.role}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Sessions */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-4">
          <MessageSquare className="h-4 w-4" />
          Recent Sessions ({user.sessions?.length ?? 0})
        </h3>
        {!user.sessions?.length ? (
          <p className="text-sm text-muted-foreground">No sessions</p>
        ) : (
          <div className="space-y-2">
            {user.sessions.slice(0, 10).map((session) => (
              <div key={session.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                <span className="text-xs font-medium truncate font-mono">
                  {session.id.slice(0, 16)}...
                </span>
                <span className="text-xs text-muted-foreground shrink-0 ml-3">
                  {new Date(session.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
