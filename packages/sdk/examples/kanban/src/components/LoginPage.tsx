// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Kanban } from 'lucide-react'
import { useStores } from '../stores'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export const LoginPage = observer(function LoginPage() {
  const { auth } = useStores()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'signin') await auth.signIn({ email, password })
    else await auth.signUp({ email, password, name: name || undefined })
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-blue-50 to-indigo-100">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <Kanban className="h-10 w-10 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Kanban Board</h1>
          <p className="text-sm text-muted-foreground">Organize your tasks visually.</p>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <Input
                type="text"
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={auth.isLoading}
              />
            )}
            <Input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={auth.isLoading}
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              disabled={auth.isLoading}
            />
            {auth.error && (
              <p className="text-sm text-destructive">{auth.error}</p>
            )}
            <Button type="submit" disabled={auth.isLoading} className="w-full">
              {auth.isLoading ? 'Please wait...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); auth.clearError() }}
            >
              {mode === 'signin' ? 'Sign up' : 'Sign in'}
            </Button>
          </p>
        </CardContent>

        <CardFooter className="justify-center">
          <p className="text-xs text-muted-foreground">Built with @shogo-ai/sdk + Hono</p>
        </CardFooter>
      </Card>
    </div>
  )
})
