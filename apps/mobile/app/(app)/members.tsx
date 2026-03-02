import { useEffect } from 'react'
import { useRouter } from 'expo-router'

/**
 * Legacy /members route — redirects to Settings > People tab.
 * Kept as a redirect so existing bookmarks and links still work.
 */
export default function MembersRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/(app)/settings?tab=people' as any)
  }, [router])

  return null
}
