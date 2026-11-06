import { Component, lazy, StrictMode, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from './Icon'
import { DictationBar } from './DictationBar'
import './styles.css'

// The always-visible voice bar should not load agents, call history, or the settings UI.
const App = lazy(() => import('./App'))

/**
 * A render error would leave the frameless window blank, with no button to close it: show what happened, and a way
 * on. The call is saved in the main process either way.
 */
class Failed extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(): void {
    // Nothing here can ask "close anyway?" during a call: closing just closes (the call is saved first).
    window.togle.pageFailed()
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    // With a bar of its own: the window has no frame, so without it the page couldn't be moved or minimized.
    return (
      <div className="app">
        <header className="titlebar">
          <div className="title">
            <span className="brand">Togle</span>
          </div>
          <div className="window-buttons">
            <button className="icon" title="Minimize" aria-label="Minimize" onClick={() => window.togle.minimize()}>
              <Icon name="minimize" />
            </button>
            <button className="icon close" title="Quit Togle" aria-label="Quit Togle" onClick={() => window.togle.close(true)}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="failed">
          <p>Something in Togle's window broke.</p>
          <p className="hint">Your call and your conversations are saved. Reload to pick them up again.</p>
          <div className="row">
            <button className="primary" onClick={() => location.reload()}>
              Reload
            </button>
            <button className="ghost" onClick={() => window.togle.close(true)}>
              Quit Togle
            </button>
          </div>
          <details className="more">
            <summary>What happened</summary>
            <p className="hint">{this.state.error.message}</p>
          </details>
        </div>
      </div>
    )
  }
}

const dictationSurface = new URLSearchParams(location.search).get('surface') === 'dictation'
if (dictationSurface) document.body.classList.add('dictation-surface')
createRoot(document.getElementById('root')!).render(dictationSurface ? <DictationBar /> : (
  <StrictMode>
    <Failed>
      <Suspense fallback={null}><App /></Suspense>
    </Failed>
  </StrictMode>
))
