import { openSettings, pointsToSettings } from './open-settings'

/** An error as the window says it: one that says to fix something in Settings links there, to the part that fixes it. */
export function ErrorText({ text }: { text: string }) {
  return (
    <p className="error">
      {text}
      {pointsToSettings(text) && (
        <>
          {' '}
          <button className="link" onClick={() => openSettings(/speech|hears|dictation/i.test(text) ? 'speech' : 'ai')}>
            Open Settings
          </button>
        </>
      )}
    </p>
  )
}
