import { createRoot } from 'react-dom/client'
import { StoreProvider } from './stores'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StoreProvider>
      <App />
    </StoreProvider>
  )
}
