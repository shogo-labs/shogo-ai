import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { Unit1Page } from './pages/Unit1Page'
import { Unit2Page } from './pages/Unit2Page'
import { Unit3Page } from './pages/Unit3Page'
import { LegacyTestsPage } from './pages/LegacyTestsPage'
import { AuthDemoPage } from './pages/AuthDemoPage'

function Navigation() {
  const location = useLocation()

  const navStyle = {
    padding: '1rem 2rem',
    background: '#1e1e1e',
    borderBottom: '2px solid #333',
    display: 'flex',
    gap: '1rem',
    alignItems: 'center'
  }

  const linkStyle = (path: string) => ({
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    textDecoration: 'none',
    fontWeight: 'bold' as const,
    fontSize: '0.95rem',
    background: location.pathname === path ? '#2196f3' : '#333',
    color: 'white',
    transition: 'background 0.2s'
  })

  return (
    <nav style={navStyle}>
      <Link to="/" style={linkStyle('/')}>
        Home
      </Link>
      <Link to="/unit1" style={linkStyle('/unit1')}>
        Unit 1: Host MST
      </Link>
      <Link to="/unit2" style={linkStyle('/unit2')}>
        Unit 2: Meta-System
      </Link>
      <Link to="/unit3" style={linkStyle('/unit3')}>
        Unit 3: App Builder
      </Link>
      <Link to="/legacy-tests" style={linkStyle('/legacy-tests')}>
        Legacy Tests
      </Link>
      <Link to="/auth-demo" style={linkStyle('/auth-demo')}>
        Auth Demo
      </Link>
    </nav>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Navigation />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/unit1" element={<Unit1Page />} />
        <Route path="/unit2" element={<Unit2Page />} />
        <Route path="/unit3" element={<Unit3Page />} />
        <Route path="/legacy-tests" element={<LegacyTestsPage />} />
        <Route path="/auth-demo/*" element={<AuthDemoPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
