import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

/* The whole interpreter is one component tree with no route boundaries, so
   any render-phase throw used to unmount everything and leave a blank white
   page — with the curation still safely in IndexedDB but no way to reach it.
   This turns that into a recoverable screen: the session is offered first,
   and clearing it is an explicit, labelled last resort. */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[crocodeel] render error:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          maxWidth: 640,
          margin: '64px auto',
          padding: '0 24px',
          fontFamily: '"Raleway", system-ui, sans-serif',
          color: '#2b2a28',
          lineHeight: 1.6,
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>
          Something went wrong while rendering.
        </h1>
        <p style={{ fontSize: 14, marginBottom: 12 }}>
          Your curation is still stored in this browser. Reloading the page
          usually brings it back — the error below is what failed.
        </p>
        <pre
          style={{
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            background: '#f3f2ef',
            border: '1px solid #ddd9d2',
            borderRadius: 3,
            padding: 12,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            marginBottom: 20,
          }}
        >
          {String(this.state.error?.message || this.state.error)}
        </pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '9px 18px',
              fontSize: 13,
              fontWeight: 700,
              color: '#fff',
              background: '#275662',
              border: 0,
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Reload the page
          </button>
          <button
            type="button"
            onClick={() => {
              // Last resort: the persisted session is what makes the crash
              // reproducible across reloads, so offer a way to drop it.
              // Destructive, hence the confirmation and the wording.
              if (
                !window.confirm(
                  'Delete the saved session (all verdicts, notes and the loaded tables) and start over? This cannot be undone.',
                )
              ) {
                return
              }
              try {
                // Must match DB_NAME in App.jsx.
                indexedDB.deleteDatabase('crocodeel-interpreter')
              } catch {
                // ignore — we reload either way
              }
              try {
                localStorage.clear()
              } catch {
                // ignore
              }
              window.location.reload()
            }}
            style={{
              padding: '9px 18px',
              fontSize: 13,
              fontWeight: 700,
              color: '#8a2422',
              background: 'transparent',
              border: '1px solid #ed6e6c',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Reset this session
          </button>
        </div>
      </div>
    )
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
