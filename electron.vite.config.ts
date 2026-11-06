import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Run in utility processes of their own (native code that must not take the app down).
          'parakeet-worker': resolve(__dirname, 'src/main/stt/parakeet-worker.ts'),
          'whisper-worker': resolve(__dirname, 'src/main/stt/whisper-worker.ts'),
          'voice-worker': resolve(__dirname, 'src/main/stt/voice-worker.ts'),
          // Reads files the user teaches agents with, in a worker with its own memory and time limits.
          'reader-worker': resolve(__dirname, 'src/main/agents/reader-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: shared }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react()],
    // Minified, the window's script is a third the size: it's read and compiled sooner as Togle starts.
    build: { minify: true, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    // Bind IPv4 explicitly; "localhost" can resolve to ::1 for Vite but 127.0.0.1 for Electron.
    server: { host: '127.0.0.1' }
  }
})
