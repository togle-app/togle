/** Public metadata only; acoustic vectors never cross into the renderer. */
export interface RememberedVoice {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface RememberVoiceResult {
  state: 'remembered' | 'learning' | 'unavailable' | 'off'
  person?: RememberedVoice
}
