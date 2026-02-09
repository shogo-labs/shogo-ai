export function LoadingSpinner({ message = 'Loading...' }: { message?: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
      <div style={{ width: 40, height: 40, border: '3px solid #e5e7eb', borderTop: '3px solid #8b5cf6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <p style={{ color: '#6b7280', fontSize: '0.875rem' }}>{message}</p>
    </div>
  )
}
if (typeof document !== 'undefined') {
  const s = document.createElement('style')
  s.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }'
  if (!document.head.querySelector('style[data-spinner]')) { s.setAttribute('data-spinner', 'true'); document.head.appendChild(s) }
}
