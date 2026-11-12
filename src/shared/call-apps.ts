/** The call apps Togle notices on its own. Any other call is started with Write down now. */
export type CallApp = 'zoom' | 'meet' | 'teams' | 'webex' | 'skype' | 'slack'

export interface CallAppInfo {
  id: CallApp
  name: string
  /** Matches the name Windows keeps for a program that used the microphone: its path with # for \, or its package. */
  match: RegExp
  /** The program's file names, to see it is still running. */
  programs: string[]
  /** Matches the title of a browser window with a call of this app in it (the app on the web). */
  site?: RegExp
}

export const CALL_APPS: CallAppInfo[] = [
  { id: 'zoom', name: 'Zoom', match: /(?:^|[#\\])zoom\.exe$/i, programs: ['Zoom.exe'], site: /\bZoom (?:Meeting|Workplace|Webinar)\b/ },
  // Meet has no program of its own: it is noticed in a browser.
  { id: 'meet', name: 'Meet', match: /(?!)/, programs: [], site: /(?:^|\s)Meet\s[-–—]\s|\bGoogle Meet\b/ },
  { id: 'teams', name: 'Teams', match: /(?:^|[#\\])(?:ms-teams|teams)\.exe$|^msteams_/i, programs: ['ms-teams.exe', 'Teams.exe'], site: /\bMicrosoft Teams\b/ },
  { id: 'webex', name: 'Webex', match: /(?:^|[#\\])(?:webex|atmgr|ciscocollabhost)\.exe$|^cisco\.?webex/i, programs: ['CiscoCollabHost.exe', 'atmgr.exe', 'Webex.exe'], site: /\bWebex\b/ },
  { id: 'skype', name: 'Skype', match: /(?:^|[#\\])skype(?:app)?\.exe$|^microsoft\.skypeapp_/i, programs: ['Skype.exe'] },
  { id: 'slack', name: 'Slack', match: /(?:^|[#\\])slack\.exe$/i, programs: ['slack.exe'] }
]

/** What to do when a call starts in an app: tell the person, write it down at once, or leave it. */
export type CallAppMode = 'ask' | 'always' | 'never'

export const callAppName = (id: CallApp): string => CALL_APPS.find(app => app.id === id)?.name ?? id
export const isCallApp = (value: unknown): value is CallApp => CALL_APPS.some(app => app.id === value)
export const isCallAppMode = (value: unknown): value is CallAppMode => value === 'ask' || value === 'always' || value === 'never'

/** The call apps whose web version is in one of these browser window titles. */
export function callSitesIn(titles: string[]): CallApp[] {
  return CALL_APPS.filter(app => app.site && titles.some(title => app.site!.test(title))).map(app => app.id)
}
