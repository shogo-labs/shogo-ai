import { observer } from 'mobx-react-lite'
import { useStores } from '../stores'
import { LoginPage } from './LoginPage'
import { LoadingSpinner } from './LoadingSpinner'

interface AuthGateProps {
  children: React.ReactNode
}

export const AuthGate = observer(function AuthGate({ children }: AuthGateProps) {
  const { auth } = useStores()

  if (auth.isLoading && !auth.user) {
    return <LoadingSpinner message="Checking authentication..." />
  }

  if (!auth.isAuthenticated) {
    return <LoginPage />
  }

  return <>{children}</>
})
