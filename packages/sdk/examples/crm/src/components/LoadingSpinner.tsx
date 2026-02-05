interface LoadingSpinnerProps {
  message?: string
}

export function LoadingSpinner({ message = 'Loading...' }: LoadingSpinnerProps) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
      <div style={{ width: '40px', height: '40px', border: '3px solid #e5e7eb', borderTop: '3px solid #3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <p style={{ color: '#6b7280', fontSize: '0.875rem' }}>{message}</p>
    </div>
  )
}

if (typeof document !== 'undefined') {
  const styleEl = document.createElement('style')
  styleEl.textContent = `@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`
  if (!document.head.querySelector('style[data-shogo-spinner]')) {
    styleEl.setAttribute('data-shogo-spinner', 'true')
    document.head.appendChild(styleEl)
  }
}
