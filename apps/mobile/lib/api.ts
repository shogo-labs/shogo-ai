import { Platform } from 'react-native'

export const API_URL = Platform.select({
  web: 'http://localhost:8002',
  ios: 'http://localhost:8002',
  android: 'http://10.0.2.2:8002',
  default: 'http://localhost:8002',
})
