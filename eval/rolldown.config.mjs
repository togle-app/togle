// Bundles what the evaluations run inside Electron: the main-process modules, and the renderer's voice
// activity detection for the end-to-end test.
import path from 'node:path'

const here = import.meta.dirname
const shared = path.resolve(here, '../src/shared')

export default [
  {
    input: path.join(here, 'entry.ts'),
    output: { file: path.join(here, '.build/togle.cjs'), format: 'cjs' },
    platform: 'node',
    external: ['electron', 'jszip', 'unpdf', 'mammoth', 'koffi', '@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', 'zod', 'ws'],
    resolve: { alias: { '@shared': shared } }
  },
  {
    input: path.resolve(here, '../src/renderer/src/audio/capture.ts'),
    output: { file: path.join(here, '.build/capture.cjs'), format: 'cjs' },
    platform: 'node',
    resolve: { alias: { '@shared': shared } }
  }
]
