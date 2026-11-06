// Shared by the test files: a scratch user-data folder, the Codex backend's streamed events, and copilots
// with a scripted model.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import electron from './electron.mjs'

/** A fresh user-data folder for one test file. Call it before loading the bundle. */
export function workDir(name) {
  const dir = path.join(import.meta.dirname, '.work', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  process.env.TOGLE_TEST_USER_DATA = dir
  return dir
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- The Codex backend: Responses API events, as server-sent events ----

export const sse = (...events) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

export const call = (id, name, args) => [
  { type: 'response.output_item.added', item: { id: `fc_${id}`, type: 'function_call', name, call_id: `call_${id}`, arguments: '' } },
  { type: 'response.output_item.done', item: { id: `fc_${id}`, type: 'function_call', name, call_id: `call_${id}`, arguments: JSON.stringify(args) } }
]

export const say = (text) => [
  { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: text },
  { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text }] } }
]

export const completed = { type: 'response.completed', response: {} }

/** The backend answers each /responses request with the next scripted round, and keeps what it was sent. */
export function backend(rounds) {
  const requests = []
  electron.net.fetch = async (url, init) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
    requests.push(JSON.parse(init.body))
    const round = rounds.shift()
    if (!round) throw new Error('the model was asked more often than scripted')
    return sse(...round, completed)
  }
  return requests
}

// ---- Copilots ----

/** What the agent store gives the copilot, for one active agent. */
export function agentAccess(store, id) {
  return {
    active: () => store.list().find((a) => a.id === id),
    get: (other) => store.list().find((a) => a.id === other),
    knowledgeFor: (a, query, seen) => store.knowledgeFor(a, query, seen),
    search: (a, query, seen, first) => store.search(a, query, seen, first),
    facts: (a, question) => store.factsFor(a, question),
    code: () => undefined
  }
}

/** A copilot for one agent, with a model that answers from a script; `access` adds to what it reads of the agent. */
export function copilotWith(Copilot, store, id, replies, access = {}) {
  const events = []
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push(input)
      onDelta(replies.shift() ?? 'LEVEL: quick\nOk.')
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot((channel, payload) => events.push({ channel, payload }), () => model, frames, { ...agentAccess(store, id), ...access })
  return { copilot, events, inputs }
}

/** The answer-card events a copilot sent, in order. */
export const shown = (events) => events.filter((e) => e.channel === 'assist').map((e) => e.payload)

/** The quick answers' requests to the model. */
export const quick = (inputs) => inputs.filter((input) => input.lane === 'quick')
