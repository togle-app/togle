// Bundles the code under test for Node: the main-process modules (with a fake Electron), and the renderer's
// voice activity detection and dictation capture.
import path from 'node:path'

const here = import.meta.dirname
const shared = path.resolve(here, '../src/shared')

export default [
  {
    input: path.join(here, 'entry.ts'),
    output: { file: path.join(here, '.build/togle.mjs'), format: 'esm' },
    platform: 'node',
    external: ['jszip', 'unpdf', 'mammoth', 'koffi', 'node-pty', '@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', 'zod', 'ws'],
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
  }
]
