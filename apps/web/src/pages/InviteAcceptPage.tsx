// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InviteAcceptPage - Landing page for invite link acceptance
 * Route: /invite/:token
 */

import { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Loader2, Users, CheckCircle, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSession } from "@/contexts/SessionProvider"

interface LinkInfo {
  role: string
  projectName?: string
  workspaceName?: string
  expired: boolean
}

export function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { data: session } = useSession()

  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAccepting, setIsAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) return
    fetch(`/api/invite-links/${token}/info`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) setInfo(data.data)
        else setError(data.error || 'Invalid invite link')
      })
      .catch(() => setError('Failed to load invite link'))
      .finally(() => setIsLoading(false))
  }, [token])

  const handleAccept = async () => {
    if (!token || !session?.user?.id) return
    setIsAccepting(true)
    setError(null)

    try {
      const res = await fetch(`/api/invite-links/${token}/accept`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) {
        setAccepted(true)
        setTimeout(() => navigate('/'), 1500)
      } else {
        setError(data.error || 'Failed to accept invite')
      }
    } catch {
      setError('Failed to accept invite')
    } finally {
      setIsAccepting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error && !info) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
          <h1 className="text-xl font-semibold">Invalid Invite Link</h1>
          <p className="text-muted-foreground">{error}</p>
          <Button onClick={() => navigate('/')}>Go to Dashboard</Button>
        </div>
      </div>
    )
  }

  if (accepted) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
          <h1 className="text-xl font-semibold">You're in!</h1>
          <p className="text-muted-foreground">
            You've joined {info?.projectName || info?.workspaceName}. Redirecting...
          </p>
        </div>
      </div>
    )
  }

  const resourceName = info?.projectName || info?.workspaceName || 'this project'

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-6 max-w-sm p-8 rounded-xl border bg-card">
        <div className="mx-auto h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Users className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">You've been invited</h1>
          <p className="text-muted-foreground mt-2">
            Join <strong>{resourceName}</strong> as {info?.role === 'member' ? 'an Editor' : `a ${info?.role}`}
          </p>
        </div>

        {info?.expired ? (
          <div className="text-destructive text-sm">This invite link has expired.</div>
        ) : !session?.user ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Sign in to accept this invitation</p>
            <Button className="w-full" onClick={() => navigate(`/?redirect=/invite/${token}`)}>
              Sign In
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" onClick={handleAccept} disabled={isAccepting}>
              {isAccepting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Accept Invitation
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
              Decline
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
