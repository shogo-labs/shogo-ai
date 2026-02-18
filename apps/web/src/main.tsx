import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initHotjar } from './lib/hotjar'

/**
 * Theme Initialization (runs BEFORE React renders)
 *
 * This code executes synchronously before createRoot to prevent
 * flash of wrong theme (FOWT). Per dd-2-1-theme-implementation-pattern:
 * - Reads theme from localStorage key 'theme'
 * - Defaults to 'dark' when no value exists
 * - Applies 'dark' class to document.documentElement
 */
const storedTheme = localStorage.getItem('theme')
const theme = storedTheme || 'dark'

if (theme === 'dark') {
  document.documentElement.classList.add('dark')
} else {
  document.documentElement.classList.remove('dark')
}

// Initialize Hotjar (no-op if VITE_HOTJAR_SITE_ID is not set)
initHotjar()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
