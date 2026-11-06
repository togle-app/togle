import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'
const directory = workDir('api-connections')
const { ApiConnections, CompatProvider, ClaudeProvider } = await import('./.build/togle.mjs')
const response = () => new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { headers: { 'content-type': 'application/json' } })

test('named API/local connections isolate keys, survive restart and return public metadata only', async () => {
  const store = new ApiConnections(new ClaudeProvider(), new CompatProvider())
  const requests = []
  electron.net.fetch = async (url, options) => { requests.push({ url, authorization: options.headers.Authorization }); return response() }
  const work = await store.add({ kind: 'compatible', label: 'Work', baseUrl: 'https://work.invalid/v1', model: '', key: 'fictional-work-key' })
  const local = await store.add({ kind: 'local', label: 'Local', baseUrl: 'http://localhost:1234/v1', model: 'fixture-model' })
  await Promise.all([store.pinned(work.id).listModels(), store.pinned(local.id).listModels()])
  assert.deepEqual(requests, [{ url: 'https://work.invalid/v1/models', authorization: 'Bearer fictional-work-key' }, { url: 'http://localhost:1234/v1/models', authorization: undefined }])
  const serialized = JSON.stringify(store.list())
  assert.ok(!serialized.includes('fictional-work-key')); assert.ok(store.list().every(connection => !('key' in connection)))
  assert.ok(!(await readFile(path.join(directory, 'connections/index.json'), 'utf8')).includes('fictional-work-key'))
  const restored = new ApiConnections(new ClaudeProvider(), new CompatProvider()); await restored.load()
  assert.deepEqual(restored.list(), store.list())
  await restored.pinned(work.id).listModels(); assert.equal(requests.at(-1).authorization, 'Bearer fictional-work-key')
})

test('an endpoint or key change invalidates a pinned connection without sending a request to another endpoint', async () => {
  const store = new ApiConnections(new ClaudeProvider(), new CompatProvider())
  const initial = { kind: 'compatible', label: 'Work', baseUrl: 'https://one.invalid/v1', model: 'fixture-model', key: 'fictional-key' }
  const connection = await store.add(initial), pinned = store.pinned(connection.id)
  await assert.rejects(store.update(connection.id, { ...initial, baseUrl: 'https://two.invalid/v1', key: undefined }), /new API key/)
  assert.equal(store.get(connection.id).metadata.baseUrl, initial.baseUrl)
  let requests = 0, release
  electron.net.fetch = () => { requests++; return new Promise(resolve => { release = resolve }) }
  const pending = pinned.listModels()
  await store.update(connection.id, { ...initial, baseUrl: 'https://two.invalid/v1', key: 'replacement-fictional-key' })
  release(response())
  await assert.rejects(pending, /connection changed/)
  await assert.rejects(pinned.listModels(), /connection changed/)
  assert.equal(requests, 1)
})

test('invalid connection URLs and missing Anthropic keys fail before storing a connection', async () => {
  const store = new ApiConnections(new ClaudeProvider(), new CompatProvider())
  for (const baseUrl of ['file:///tmp/server', 'https://name:secret@example.test/v1', 'https://example.test/v1?key=secret']) await assert.rejects(store.add({ kind: 'compatible', label: 'Invalid', baseUrl, model: '' }), /HTTP|credentials/)
  await assert.rejects(store.add({ kind: 'anthropic', label: 'API', baseUrl: '', model: '' }), /API key/)
})
