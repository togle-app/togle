import type { Settings } from '@shared/types'
import type { SettingsPatch } from '@shared/api'
import { CALL_APPS, isCallAppMode, type CallApp, type CallAppMode } from '@shared/call-apps'
import { Row, Section, Toggle } from './Rows'

const platform = window.togle.platform

/** What Togle does when a call starts in a call app, for each app: tell the person, write it down at once, or leave it. */
export function CallAppSettings({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<unknown> }) {
  // Only Windows can say which program is using the microphone.
  if (platform !== 'win32') return null
  const apps = settings.meetings.apps
  const modeOf = (id: CallApp): CallAppMode => (isCallAppMode(apps[id]) ? apps[id]! : 'ask')
  return (
    <Section id="settings-meetings" title="Call apps" note="Meet in a browser, and any other call, is started with Write down now in Meetings. Togle looks at which program is using the microphone; it never listens before you say to write a call down.">
      <Toggle name="Tell me when a call starts" note="A small notice offers to write it down, when a call starts in one of these apps." checked={settings.meetings.notice} onChange={notice => void save({ meetings: { ...settings.meetings, notice } })} />
      {CALL_APPS.map(app => (
        <Row key={app.id} name={app.name}>
          <select aria-label={`When a call starts in ${app.name}`} value={modeOf(app.id)} disabled={!settings.meetings.notice} onChange={event => void save({ meetings: { ...settings.meetings, apps: { ...apps, [app.id]: event.target.value as CallAppMode } } })}>
            <option value="ask">Ask</option>
            <option value="always">Always write down</option>
            <option value="never">Never</option>
          </select>
        </Row>
      ))}
    </Section>
  )
}
