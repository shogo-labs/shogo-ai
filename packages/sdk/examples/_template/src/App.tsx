import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogOut } from 'lucide-react'

const AppContent = observer(function AppContent() {
  const { auth } = useStores()

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Welcome</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => auth.signOut()}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
          <CardDescription>
            Signed in as <span className="font-medium text-foreground">{auth.user?.name || auth.user?.email}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This is a blank starter template. Edit <code className="bg-muted px-1.5 py-0.5 rounded text-xs">src/App.tsx</code> to start building your app.
          </p>
        </CardContent>
      </Card>
    </div>
  )
})

export default function App() {
  return (
    <AuthGate>
      <AppContent />
    </AuthGate>
  )
}
