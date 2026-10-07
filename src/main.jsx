import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { sessionToJSON } from './persistence.js'
import { deleteStoredSession, readStoredSessionForRescue } from './storage.js'

/* The last line of defence: a render-phase throw outside the tabs (each
   tab has its own boundary in App.jsx, which keeps the navigation and
   Export usable) used to unmount everything and leave a blank page. This
   turns that into a recoverable screen that says what this browser has
   stored — it used to claim the curation was "still stored" even after a
   failed session import had cleared it — offers it as a session JSON,
   and keeps deleting it an explicit, labelled last resort. */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, stored: undefined }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[crocodeel] render error:', error, info?.componentStack)
    // What is stored, read without migrating or writing anything:
    // undefined while reading, null when nothing is.
    readStoredSessionForRescue().then(
      (stored) => this.setState({ stored: stored || null }),
      () => this.setState({ stored: null }),
    )
  }

  downloadStored() {
    const { stored } = this.state
    if (!stored) return
    const blob = new Blob([JSON.stringify(sessionToJSON(stored), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'crocodeel_curation_session.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  render() {
    if (!this.state.error) return this.props.children
    const { stored } = this.state
    const events = stored?.rawEvents?.length || 0
    const evaluated = (stored?.rawEvents || []).filter(
      (e) => e.verdict && e.verdict !== 'pending',
    ).length
    const files = [
      events ? `${events} event${events === 1 ? '' : 's'} (${evaluated} evaluated)` : null,
      stored?.ab ? 'the abundance table' : null,
      stored?.metadata ? 'the metadata' : null,
      stored?.plateMap ? 'the plate map' : null,
    ].filter(Boolean)
    const button = (label, onClick, primary) => (
      <button
        type="button"
        onClick={onClick}
        style={{
          padding: '9px 18px',
          fontSize: 13,
          fontWeight: 700,
          color: primary ? '#fff' : '#275662',
          background: primary ? '#275662' : 'transparent',
          border: primary ? 0 : '1px solid #275662',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    )
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
        <p data-stored-session style={{ fontSize: 14, marginBottom: 12 }}>
          {stored === undefined
            ? 'Checking what this browser has stored…'
            : stored
              ? `This browser has the last saved version of your session: ${files.join(', ')}${stored.analysisTitle ? ` — “${stored.analysisTitle}”` : ''}. Reloading the page usually brings it back; download it first if the error comes back.`
              : 'This browser has no saved session to bring back (nothing was saved yet, or its storage is unavailable). Reloading the page starts again from the files.'}{' '}
          The error below is what failed.
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
          {button('Reload the page', () => window.location.reload(), true)}
          {stored && button('Download the saved session (JSON)', () => this.downloadStored())}
          {stored && (
            <button
              type="button"
              onClick={() => {
                // Last resort: the persisted session is what makes the
                // crash reproducible across reloads, so offer a way to drop
                // it. Destructive, hence the confirmation and the wording.
                if (
                  !window.confirm(
                    'Delete the saved session (all verdicts, notes and the loaded tables) and start over? This cannot be undone: download it first to keep it.',
                  )
                ) {
                  return
                }
                deleteStoredSession().then(() => {
                  try {
                    localStorage.clear()
                  } catch {
                    // ignore
                  }
                  window.location.reload()
                })
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
          )}
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
