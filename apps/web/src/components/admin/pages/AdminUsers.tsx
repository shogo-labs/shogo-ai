/**
 * AdminUsers - User management page with list, search, and role management.
 */

import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Search, MoreHorizontal, Shield, User, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAdminUsers, adminUpdateUser } from '../hooks/useAdminApi'

export function AdminUsers() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [roleFilter, setRoleFilter] = useState<string>('')

  const params: Record<string, string> = {
    page: String(page),
    limit: '20',
  }
  if (search) params.search = search
  if (roleFilter) params.role = roleFilter

  const { data, loading, refetch } = useAdminUsers(params)

  const handleToggleRole = useCallback(async (userId: string, currentRole: string) => {
    const newRole = currentRole === 'super_admin' ? 'user' : 'super_admin'
    const result = await adminUpdateUser(userId, { role: newRole })
    if (result.ok) {
      refetch()
    }
  }, [refetch])

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-xl font-bold">Users</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage platform users and their roles
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          {['', 'user', 'super_admin'].map((role) => (
            <button
              key={role}
              onClick={() => {
                setRoleFilter(role)
                setPage(1)
              }}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                roleFilter === role
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {role === '' ? 'All' : role === 'super_admin' ? 'Admins' : 'Users'}
            </button>
          ))}
        </div>
      </div>

      {/* Users Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left text-xs font-medium text-muted-foreground p-3">User</th>
              <th className="text-left text-xs font-medium text-muted-foreground p-3">Role</th>
              <th className="text-left text-xs font-medium text-muted-foreground p-3">Memberships</th>
              <th className="text-left text-xs font-medium text-muted-foreground p-3">Sessions</th>
              <th className="text-left text-xs font-medium text-muted-foreground p-3">Joined</th>
              <th className="text-right text-xs font-medium text-muted-foreground p-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                </td>
              </tr>
            ) : data?.users?.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">
                  No users found
                </td>
              </tr>
            ) : (
              data?.users?.map((user) => (
                <tr key={user.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="p-3">
                    <Link
                      to={`/admin/users/${user.id}`}
                      className="flex items-center gap-3 group"
                    >
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        {user.image ? (
                          <img src={user.image} alt="" className="h-8 w-8 rounded-full" />
                        ) : (
                          <span className="text-xs font-medium text-primary">
                            {(user.name || user.email).charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                          {user.name || 'Unnamed'}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {user.email}
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="p-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                        user.role === 'super_admin'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {user.role === 'super_admin' ? (
                        <Shield className="h-3 w-3" />
                      ) : (
                        <User className="h-3 w-3" />
                      )}
                      {user.role === 'super_admin' ? 'Admin' : 'User'}
                    </span>
                  </td>
                  <td className="p-3 text-sm text-muted-foreground">
                    {user._count.members}
                  </td>
                  <td className="p-3 text-sm text-muted-foreground">
                    {user._count.sessions}
                  </td>
                  <td className="p-3 text-sm text-muted-foreground">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="p-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link to={`/admin/users/${user.id}`}>
                            View Details
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleToggleRole(user.id, user.role)}>
                          {user.role === 'super_admin' ? 'Remove Admin' : 'Make Admin'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {data?.total} users total
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
