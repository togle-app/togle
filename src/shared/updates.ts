/** Where Togle's own update stands: none set up (no release key), up to date, checking, downloading, ready to install,
 * refused (not signed by the release key) or failed. */
export type UpdatePhase = 'off' | 'none' | 'checking' | 'downloading' | 'ready' | 'refused' | 'failed'
export interface UpdateState { phase: UpdatePhase; version?: string; message?: string; checkedAt?: number }
