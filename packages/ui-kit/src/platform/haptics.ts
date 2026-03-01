import { Platform } from 'react-native'

type ImpactStyle = 'light' | 'medium' | 'heavy'

export const haptics = {
  async impact(style: ImpactStyle = 'light') {
    if (Platform.OS === 'web') return
    try {
      const Haptics = (await import('expo-haptics')).default
      const map = {
        light: Haptics.ImpactFeedbackStyle.Light,
        medium: Haptics.ImpactFeedbackStyle.Medium,
        heavy: Haptics.ImpactFeedbackStyle.Heavy,
      }
      await Haptics.impactAsync(map[style])
    } catch {}
  },

  async notification(type: 'success' | 'warning' | 'error' = 'success') {
    if (Platform.OS === 'web') return
    try {
      const Haptics = (await import('expo-haptics')).default
      const map = {
        success: Haptics.NotificationFeedbackType.Success,
        warning: Haptics.NotificationFeedbackType.Warning,
        error: Haptics.NotificationFeedbackType.Error,
      }
      await Haptics.notificationAsync(map[type])
    } catch {}
  },

  async selection() {
    if (Platform.OS === 'web') return
    try {
      const Haptics = (await import('expo-haptics')).default
      await Haptics.selectionAsync()
    } catch {}
  },
}
