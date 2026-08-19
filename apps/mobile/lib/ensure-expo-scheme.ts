import Constants from 'expo-constants'

const fallbackScheme = 'shogo'
const fallbackIosBundleIdentifier = 'ai.shogo.app'

type MutableExpoConfig = {
  scheme?: string | string[]
  ios?: {
    scheme?: string | string[]
    bundleIdentifier?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

function hasScheme(value: unknown): boolean {
  return typeof value === 'string'
    ? value.length > 0
    : Array.isArray(value) && value.some((item) => typeof item === 'string' && item.length > 0)
}

const expoConfig = Constants.expoConfig as unknown as MutableExpoConfig | null | undefined

if (expoConfig) {
  if (!hasScheme(expoConfig.scheme)) {
    expoConfig.scheme = fallbackScheme
  }

  expoConfig.ios = {
    ...expoConfig.ios,
    scheme: hasScheme(expoConfig.ios?.scheme) ? expoConfig.ios?.scheme : fallbackScheme,
    bundleIdentifier: expoConfig.ios?.bundleIdentifier ?? fallbackIosBundleIdentifier,
  }
}
