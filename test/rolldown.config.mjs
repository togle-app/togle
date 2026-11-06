// Bundles the code under test for Node: the main-process modules (with a fake Electron), and the renderer's
// voice activity detection and screen change detection.
import path from 'node:path'

const here = import.meta.dirname
const shared = path.resolve(here, '../src/shared')

export default [
  {
    input: path.join(here, 'entry.ts'),
    output: { file: path.join(here, '.build/togle.mjs'), format: 'esm' },
    platform: 'node',
    external: ['jszip', 'unpdf', 'mammoth', 'koffi', '@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', 'zod', 'ws'],
    resolve: { alias: { '@shared': shared, electron: path.join(here, 'electron.mjs') } }
  },
  {
    input: path.resolve(here, '../src/renderer/src/audio/capture.ts'),
    output: { file: path.join(here, '.build/capture.mjs'), format: 'esm' },
    platform: 'node',
    resolve: { alias: { '@shared': shared } }
  },
  {
    input: path.resolve(here, '../src/renderer/src/audio/dictation.ts'),
    output: { file: path.join(here, '.build/dictation-capture.mjs'), format: 'esm' },
    platform: 'node',
    resolve: { alias: { '@shared': shared } }
  },
  {
    input: path.resolve(here, '../src/renderer/src/video/changes.ts'),
    output: { file: path.join(here, '.build/changes.mjs'), format: 'esm' },
    platform: 'node'
  },
  {
    input: path.resolve(here, '../src/renderer/src/video/recorder.ts'),
    output: { file: path.join(here, '.build/recorder.mjs'), format: 'esm' },
    platform: 'node'
  },
  {
    input: path.join(here, 'screen-capture-driver.ts'),
    output: { file: path.join(here, '.build/screen-capture-driver.js'), format: 'iife' },
    platform: 'browser',
    resolve: { alias: { '@shared': shared } }
  }
]
