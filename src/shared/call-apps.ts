/** The call apps Togle notices on its own. A call in a browser (Meet, Teams on the web) is started with Write down now. */
export type CallApp = 'zoom' | 'teams' | 'webex' | 'skype' | 'slack'

export interface CallAppInfo {
  id: CallApp
  name: string
  /** Matches the name Windows keeps for a program that used the microphone: its path with # for \, or its package. */
  match: RegExp
  /** The program's file names, to see it is still running. */
  programs: string[]
}

export const CALL_APPS: CallAppInfo[] = [
  { id: 'zoom', name: 'Zoom', match: /(?:^|[#\\])zoom\.exe$/i, programs: ['Zoom.exe'] },
  { id: 'teams', name: 'Teams', match: /(?:^|[#\\])(?:ms-teams|teams)\.exe$|^msteams_/i, programs: ['ms-teams.exe', 'Teams.exe'] },
  { id: 'webex', name: 'Webex', match: /(?:^|[#\\])(?:webex|atmgr|ciscocollabhost)\.exe$|^cisco\.?webex/i, programs: ['CiscoCollabHost.exe', 'atmgr.exe', 'Webex.exe'] },
  { id: 'skype', name: 'Skype', match: /(?:^|[#\\])skype(?:app)?\.exe$|^microsoft\.skypeapp_/i, programs: ['Skype.exe'] },
  { id: 'slack', name: 'Slack', match: /(?:^|[#\\])slack\.exe$/i, programs: ['slack.exe'] }
]

/** What to do when a call starts in an app: tell the person, write it down at once, or leave it. */
export type CallAppMode = 'ask' | 'always' | 'never'

export const callAppName = (id: CallApp): string => CALL_APPS.find(app => app.id === id)?.name ?? id
export const isCallApp = (value: unknown): value is CallApp => CALL_APPS.some(app => app.id === value)
export const isCallAppMode = (value: unknown): value is CallAppMode => value === 'ask' || value === 'always' || value === 'never'
