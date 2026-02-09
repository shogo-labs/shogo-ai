/**
 * AdminWorkspaces - Workspace management page.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Building2, Users, FolderKanban, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useAdminWorkspaces } from '../hooks/useAdminApi'

export function AdminWorkspaces() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const params: Record<string, string> = {
    page: String(page),
    limit: '20',
  }
  if (search) params.search = search

  const { data, loading } = useAdminWorkspaces(params)
  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-xl font-bold">Workspaces</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Browse and manage all platform workspaces
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search workspaces..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="pl-9"
        />
      </div>

      {/* Workspace Grid */}
      {loading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data?.workspaces?.length === 0 ? (
        <div className="text-center p-12 text-sm text-muted-foreground">
          No workspaces found
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.workspaces?.map((ws) => (
            <Link
              key={ws.id}
              to={`/admin/workspaces/${ws.id}`}
              className="rounded-xl border border-border bg-card p-5 hover:border-primary/30 transition-colors group"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                    {ws.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {ws.slug}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {ws._count.members} members
                </span>
                <span className="flex items-center gap-1">
                  <FolderKanban className="h-3.5 w-3.5" />
                  {ws._count.projects} projects
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                Created {new Date(ws.createdAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {data?.total} workspaces total
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
