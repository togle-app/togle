/** What the small strip shows while a call is written down and Togle's window is closed. */
export interface CallStripState {
  /** When the call began (epoch ms), for the clock. */
  since: number
  /** The person said they told the others the call is written down. */
  told: boolean
  /** The moments marked so far. */
  marks: number
}

/** Mark a moment, end the call, copy the line to tell the others, or say they were told. */
export type CallStripAction = 'mark' | 'stop' | 'copy' | 'told'

export const isCallStripAction = (value: unknown): value is CallStripAction => value === 'mark' || value === 'stop' || value === 'copy' || value === 'told'
