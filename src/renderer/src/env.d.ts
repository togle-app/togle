/// <reference types="vite/client" />
import type { TogleApi } from '@shared/api'

declare global {
  interface Window {
    togle: TogleApi
    /** Dev only (TOGLE_DEBUG_PORT): what test runs drive. */
    togleDev?: { silentAudio?: boolean; noiseReport?: () => import('@shared/microphone').NoiseReport & { sample?: Float32Array } }
  }
}
