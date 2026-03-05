import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig } from '../../lib/platform-config'
import { LoginScreen } from '@shogo/shared-ui/screens'

export default function SignInScreen() {
  const { signIn, signUp, signInWithGoogle, isLoading, error, clearError } = useAuth()
  const { features } = usePlatformConfig()

  const handleSignIn = async (email: string, password: string) => {
    try {
      await signIn(email, password)
    } catch {}
  }

  const handleSignUp = async (name: string, email: string, password: string) => {
    try {
      await signUp(name, email, password)
    } catch {}
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <LoginScreen
        onSignIn={handleSignIn}
        onSignUp={handleSignUp}
        onGoogleSignIn={features.oauth ? signInWithGoogle : undefined}
        isLoading={isLoading}
        error={error}
      />
    </SafeAreaView>
  )
}
