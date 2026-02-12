/**
 * AdminShell - Separate layout for the super admin portal.
 *
 * Provides its own sidebar navigation and header, distinct from the main AppShell.
 */

import { useState } from 'react'
import { Outlet, NavLink, Link } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  Building2,
  BarChart3,
  ArrowLeft,
  PanelLeftClose,
  PanelLeft,
  Shield,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useSessionContext } from '@/contexts/SessionProvider'

const navItems = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/admin/users', icon: Users, label: 'Users', end: false },
  { to: '/admin/workspaces', icon: Building2, label: 'Workspaces', end: false },
  { to: '/admin/analytics', icon: BarChart3, label: 'Analytics', end: false },
]

export function AdminShell() {
  const [collapsed, setCollapsed] = useState(false)
  const { data } = useSessionContext()

  return (
    <div className="h-screen flex bg-background">
      {/* Admin Sidebar */}
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-muted/30 transition-all duration-200',
          collapsed ? 'w-16' : 'w-60'
        )}
      >
        {/* Sidebar Header */}
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <Shield className="h-5 w-5 text-primary shrink-0" />
          {!collapsed && (
            <span className="font-semibold text-sm truncate">Super Admin</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7 shrink-0"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Back to App */}
        <div className="p-2 border-t border-border">
          <Link to="/">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start gap-3 text-muted-foreground hover:text-foreground',
                collapsed && 'justify-center px-0'
              )}
              size="sm"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Back to App</span>}
            </Button>
          </Link>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Admin Header */}
        <header className="h-14 flex items-center px-6 border-b border-border bg-background shrink-0">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <h1 className="text-sm font-semibold">Admin Portal</h1>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {data?.user?.email}
            </span>
            <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-xs font-medium text-primary">
                {data?.user?.name?.charAt(0)?.toUpperCase() || 'A'}
              </span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
