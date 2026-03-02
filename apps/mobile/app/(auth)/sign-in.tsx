import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { LoginScreen } from '@shogo/shared-ui/screens'

export default function SignInScreen() {
  const router = useRouter()
  const { signIn, signUp, signInWithGoogle, isLoading, error, clearError } = useAuth()

  const handleSignIn = async (email: string, password: string) => {
    try {
      await signIn(email, password)
      router.replace('/(app)')
    } catch {}
  }

  const handleSignUp = async (name: string, email: string, password: string) => {
    try {
      await signUp(name, email, password)
      router.replace('/(app)')
    } catch {}
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <LoginScreen
        onSignIn={handleSignIn}
        onSignUp={handleSignUp}
        onGoogleSignIn={signInWithGoogle}
        isLoading={isLoading}
        error={error}
        onClearError={clearError}
      />
    </SafeAreaView>
  )
}
