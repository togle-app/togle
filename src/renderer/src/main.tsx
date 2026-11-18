import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrandMark, WindowButtons } from './WindowBar'
import { DictationBar } from './DictationBar'
import { TaskBox } from './TaskBox'
import { CallNoticeSurface } from './CallNoticeSurface'
import { KeysNoticeSurface } from './KeysNoticeSurface'
import { CallStripSurface } from './CallStripSurface'
import { ShowSurface } from './ShowSurface'
import { TaskNoticeSurface } from './TaskNoticeSurface'
// The design's two typefaces, kept with the app: Inter for text, Bricolage Grotesque for a page's heading.
import '@fontsource-variable/inter'
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import './styles.css'
import './design.css'

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
            <span className="brand"><BrandMark /><span className="brand-name">Togle</span></span>
          </div>
          <WindowButtons closeTitle="Quit Togle" closeLabel="Quit Togle" onClose={() => window.togle.close(true)} />
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

/** A window whose script didn't load says so, in the Failed boundary, rather than staying blank. */
function Unloaded({ error }: { error: Error }): ReactNode {
  throw error
}

const surface = new URLSearchParams(location.search).get('surface')
const dictationSurface = surface === 'dictation'
const noticeSurface = surface === 'notice'
const taskBoxSurface = surface === 'taskbox'
const callNoticeSurface = surface === 'callnotice'
const keysNoticeSurface = surface === 'keysnotice'
const callStripSurface = surface === 'callstrip'
const showSurface = surface === 'show'
if (dictationSurface) document.body.classList.add('dictation-surface')
if (noticeSurface) document.body.classList.add('notice-surface')
if (taskBoxSurface) document.body.classList.add('taskbox-surface')
if (callNoticeSurface) document.body.classList.add('notice-surface', 'callnotice-surface')
// The keys notice looks like the call notice: it has that one's styles.
if (keysNoticeSurface) document.body.classList.add('notice-surface', 'callnotice-surface', 'keysnotice-surface')
if (callStripSurface) document.body.classList.add('notice-surface', 'callstrip-surface')
if (showSurface) document.body.classList.add('show-surface')
const root = createRoot(document.getElementById('root')!)
if (dictationSurface) root.render(<DictationBar />)
else if (noticeSurface) root.render(<TaskNoticeSurface />)
else if (taskBoxSurface) root.render(<TaskBox />)
else if (callNoticeSurface) root.render(<CallNoticeSurface />)
else if (keysNoticeSurface) root.render(<KeysNoticeSurface />)
else if (callStripSurface) root.render(<CallStripSurface />)
else if (showSurface) root.render(<ShowSurface />)
else {
  // The always-visible voice bar doesn't load agents, call history, or the settings UI: the main window loads them
  // here, before its first render. Not with React.lazy: React 19 holds back what a Suspense boundary reveals for up to
  // 300 ms after its fallback, and the window would stay empty that long as Togle starts.
  void import('./Shell').then(
    ({ Shell }) => root.render(<StrictMode><Failed><Shell /></Failed></StrictMode>),
    (error: Error) => root.render(<Failed><Unloaded error={error} /></Failed>)
  )
}
