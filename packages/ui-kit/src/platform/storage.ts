import { Platform } from 'react-native'

interface StorageInterface {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

class WebStorage implements StorageInterface {
  async getItem(key: string) {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  }
  async setItem(key: string, value: string) {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  }
  async removeItem(key: string) {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(key)
  }
}

class NativeStorage implements StorageInterface {
  private _asyncStorage: any = null

  private async getAsyncStorage() {
    if (!this._asyncStorage) {
      const mod = await import('@react-native-async-storage/async-storage')
      this._asyncStorage = mod.default
    }
    return this._asyncStorage
  }

  async getItem(key: string) {
    const as = await this.getAsyncStorage()
    return as.getItem(key)
  }
  async setItem(key: string, value: string) {
    const as = await this.getAsyncStorage()
    return as.setItem(key, value)
  }
  async removeItem(key: string) {
    const as = await this.getAsyncStorage()
    return as.removeItem(key)
  }
}

export const storage: StorageInterface =
  Platform.OS === 'web' ? new WebStorage() : new NativeStorage()
