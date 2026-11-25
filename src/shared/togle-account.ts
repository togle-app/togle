/** Togle identity is optional. AI provider sign-ins and device pairing have their own controls. */
export interface TogleAccountState {
  available: boolean
  problem?: string
  user?: { id: string; email: string }
}
