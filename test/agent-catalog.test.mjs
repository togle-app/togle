// What Add another agent lists (src/main/runners/agent-catalog.ts): the agents on this computer, and more from the ACP registry, each with
// the command that starts it. The registry is data from the network, so every word that ends up in a command is checked.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const { agentCatalog, commandIsAcp, commandOf, KNOWN_TO_START, registryEntries, registryPlatform, rememberedWhere, RegistryKeeper } = await import('./.build/togle.mjs')

/** The registry as it gives its agents (the shape of cdn.agentclientprotocol.com/registry/v1/latest/registry.json), a few of them. */
const registry = {
  version: '1.0.0',
  agents: [
    { id: 'codex-acp', name: 'Codex', description: 'ACP adapter for OpenAI\'s coding assistant', distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.8.0' } } },
    { id: 'claude-acp', name: 'Claude Agent', description: 'ACP wrapper for Anthropic\'s Claude', distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.109.0' } } },
    { id: 'gemini', name: 'Gemini CLI', description: 'Google\'s official CLI for Gemini', distribution: { npx: { package: '@google/gemini-cli@0.70.0', args: ['--acp'] } } },
    { id: 'goose', name: 'goose', description: 'A local, extensible, open source AI agent', distribution: { binary: { 'windows-x86_64': { archive: 'https://example.invalid/goose.zip', cmd: './goose.exe', args: ['acp'] }, 'linux-x86_64': { archive: 'https://example.invalid/goose.tgz', cmd: './goose', args: ['acp'] } } } },
    { id: 'mistral-vibe', name: 'Mistral Vibe', description: 'Mistral\'s coding agent', distribution: { uvx: { package: 'mistral-vibe', args: ['--acp'] } } },
    { id: 'kiro', name: 'Kiro', description: 'A binary for another system only', distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.invalid/kiro.zip', cmd: './kiro-cli', args: ['acp'] } } } },
    { id: 'amp-acp', name: 'Amp', description: 'Amp, through its ACP adapter', distribution: { npx: { package: '@sourcegraph/amp-acp@1.2.3' } } }
  ]
}

test('the registry\'s agents become entries: how each starts, for this system; what Togle finds by itself is left out', () => {
  const entries = registryEntries(registry, 'windows-x86_64')
  assert.deepEqual(entries.map((entry) => entry.id), ['gemini', 'goose', 'mistral-vibe', 'amp-acp'], 'not Codex or Claude (Togle finds them), nor the binary for another system')
  const by = Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  assert.deepEqual(by.gemini.npx, ['@google/gemini-cli@0.70.0', '--acp'])
  assert.deepEqual(by.goose.program, { name: 'goose', args: ['acp'] }, '.exe is not part of the program\'s name')
  assert.deepEqual(by['mistral-vibe'].uvx, ['mistral-vibe', '--acp'])
  assert.equal(commandOf('npx', by.gemini.npx), 'npx -y @google/gemini-cli@0.70.0 --acp', 'npx is told to fetch without asking: nobody is there to answer')
  assert.equal(commandOf('uvx', by['mistral-vibe'].uvx), 'uvx mistral-vibe --acp')
  assert.deepEqual(registryEntries(registry, 'linux-x86_64').map((entry) => entry.id), ['gemini', 'goose', 'mistral-vibe', 'amp-acp'])
  assert.deepEqual(registryEntries(registry, 'darwin-aarch64').find((entry) => entry.id === 'kiro')?.program, { name: 'kiro-cli', args: ['acp'] })
})

test('a word of the registry that could be a command of its own never gets into one', () => {
  const evil = (distribution) => registryEntries({ agents: [{ id: 'evil', name: 'Evil', description: 'x', distribution }] }, 'windows-x86_64')
  assert.deepEqual(evil({ npx: { package: 'good-acp', args: ['--acp; calc'] } }), [], 'a semicolon in an argument')
  assert.deepEqual(evil({ npx: { package: 'good acp --yes' } }), [], 'spaces in a package')
  assert.deepEqual(evil({ npx: { package: 'good-acp', args: ['--acp', '$(calc)'] } }), [], 'a substitution')
  assert.deepEqual(evil({ npx: { package: 'good-acp', args: ['"--acp"'] } }), [], 'a quote')
  assert.deepEqual(evil({ npx: { package: 'good-acp', args: 'acp' } }), [], 'arguments that are not a list')
  assert.deepEqual(evil({ npx: { package: 'good-acp', args: Array.from({ length: 9 }, () => '--acp') } }), [], 'too many arguments')
  assert.deepEqual(evil({ binary: { 'windows-x86_64': { cmd: '.\\..\\evil\\run me.exe', args: ['acp'] } } }), [], 'a program name with a space')
  assert.deepEqual(evil({ npx: { package: 'tool', args: ['--stdio'] } }), [], 'a command Togle would not take for ACP is left out, not run in a terminal')
  assert.equal(evil({ npx: { package: '@scope/good-acp@1.0.0-rc.1', args: ['--acp', '--model=fast'] } }).length, 1, 'plain words pass')
  assert.deepEqual(registryEntries(null), [])
  assert.deepEqual(registryEntries({ agents: 'no' }), [])
  assert.deepEqual(registryEntries({ agents: [null, 4, { id: 'x' }] }), [], 'what is not an agent is left out')
})

const where = (...on) => async (program) => (on.includes(program) ? `C:\\tools\\${program}.exe` : null)

test('found on this computer: the agents Togle knows that are installed, and the registry\'s binaries that are; more: what starts through npx or uvx', async () => {
  const catalog = await agentCatalog({ added: [], fetchRegistry: async () => registry, whereIs: where('goose', 'aider', 'npx', 'uvx'), platform: 'windows-x86_64' })
  assert.equal(catalog.registry, true)
  assert.deepEqual(catalog.found.map((choice) => [choice.name, choice.command]), [['Aider', 'aider'], ['goose', 'goose acp']], 'goose once, though Togle knows it and the registry lists it')
  assert.deepEqual(catalog.more.map((choice) => [choice.name, choice.command]), [
    ['Amp', 'npx -y @sourcegraph/amp-acp@1.2.3'],
    ['Gemini CLI', 'npx -y @google/gemini-cli@0.70.0 --acp'],
    ['Mistral Vibe', 'uvx mistral-vibe --acp']
  ])
  assert.ok(catalog.more.every((choice) => !choice.needs), 'npx and uvx are here')
  for (const choice of [...catalog.found, ...catalog.more].filter((one) => one.name !== 'Aider')) assert.equal(commandIsAcp(choice.command), true, `${choice.name}: its command is for ACP`)
  assert.equal(commandIsAcp('aider'), false, 'Aider runs in a terminal of Togle\'s own')
})

test('an agent that is installed is found, with the command Togle knows for it, and is not listed twice under more', async () => {
  const catalog = await agentCatalog({ added: [], fetchRegistry: async () => registry, whereIs: where('gemini', 'npx'), platform: 'windows-x86_64' })
  assert.deepEqual(catalog.found.map((choice) => [choice.name, choice.command]), [['Gemini CLI', 'gemini --acp']])
  assert.equal(catalog.more.some((choice) => choice.name === 'Gemini CLI'), false)
})

test('what needs npx or uvx says so when this computer has neither', async () => {
  const catalog = await agentCatalog({ added: [], fetchRegistry: async () => registry, whereIs: where(), platform: 'windows-x86_64' })
  assert.deepEqual(catalog.found, [])
  assert.deepEqual(catalog.more.map((choice) => [choice.name, choice.needs]), [['Amp', 'npx'], ['Gemini CLI', 'npx'], ['Mistral Vibe', 'uvx']])
})

test('an agent the person added is not offered again, by its name or by its command', async () => {
  const added = [{ id: 'acp-gemini-cli', name: 'Gemini CLI', command: 'gemini --acp' }, { id: 'acp-x', name: 'Mine', command: 'goose acp' }]
  const catalog = await agentCatalog({ added, fetchRegistry: async () => registry, whereIs: where('goose', 'aider', 'npx'), platform: 'windows-x86_64' })
  assert.deepEqual(catalog.found.map((choice) => choice.name), ['Aider'], 'goose is there under another name, with the same command')
  assert.equal(catalog.more.some((choice) => choice.name === 'Gemini CLI'), false)
})

test('offline, what Togle knows is still listed, and more is empty', async () => {
  const catalog = await agentCatalog({ added: [], fetchRegistry: async () => { throw new Error('offline') }, whereIs: where('gemini', 'opencode') })
  assert.equal(catalog.registry, false)
  assert.deepEqual(catalog.found.map((choice) => choice.name), ['Gemini CLI', 'OpenCode'])
  assert.deepEqual(catalog.more, [])
  const empty = await agentCatalog({ added: [], fetchRegistry: async () => 'not a registry', whereIs: where() })
  assert.deepEqual([empty.registry, empty.found, empty.more], [true, [], []], 'a list that is not a registry holds no agent, and is not an error')
})

test('the programs are looked for together and once each: a few dozen lookups one after the other took a second and a half', async () => {
  let active = 0
  let most = 0
  const asked = []
  const slow = async (program) => {
    asked.push(program)
    active++
    most = Math.max(most, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active--
    return program === 'npx' ? 'C:\\tools\\npx.cmd' : null
  }
  const catalog = await agentCatalog({ added: [], fetchRegistry: async () => registry, whereIs: slow, platform: 'windows-x86_64' })
  assert.equal(new Set(asked).size, asked.length, 'each program once, though several entries start through npx')
  assert.ok(asked.includes('npx') && asked.includes('uvx') && asked.includes('goose') && asked.includes('aider'))
  assert.ok(most > 1, `more than one lookup at a time (most ${most})`)
  assert.ok(most <= 8, `and not a flood of them (most ${most})`)
  assert.deepEqual(catalog.more.map((choice) => [choice.name, choice.needs]), [['Amp', undefined], ['Gemini CLI', undefined], ['Mistral Vibe', 'uvx']])
})

test('where a program is, remembered for a while: each answer once in that time, and an answer that failed is asked again', async () => {
  let clock = 1000
  const asked = []
  let failing = true
  const where = rememberedWhere(async (program) => {
    asked.push(program)
    if (program === 'flaky' && failing) throw new Error('could not look')
    return program === 'here' ? 'C:\\tools\\here.exe' : null
  }, 60_000, () => clock)
  assert.equal(await where('here'), 'C:\\tools\\here.exe')
  assert.equal(await where('here'), 'C:\\tools\\here.exe')
  assert.equal(await where('missing'), null)
  assert.equal(await where('missing'), null, 'nothing found is remembered as well')
  assert.deepEqual(asked, ['here', 'missing'], 'two lookups for four questions')
  clock += 61_000
  await where('here')
  assert.deepEqual(asked, ['here', 'missing', 'here'], 'a minute later it is looked for again: something may have been installed')
  await assert.rejects(where('flaky'), /could not look/)
  failing = false
  assert.equal(await where('flaky'), null, 'a failed lookup is not kept')
  assert.equal(asked.filter((program) => program === 'flaky').length, 2)
})

test('the registry: the first read waits for the network and is kept on disk; after a restart the copy answers at once and a fresh one is read behind it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-registry-'))
  const file = path.join(dir, 'agent-registry.json')
  try {
    let clock = 1_000
    let reads = 0
    let online = true
    const net = async () => {
      reads++
      if (!online) throw new Error('offline')
      return new Response(JSON.stringify(registry), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const first = new RegistryKeeper(file, net, () => clock)
    assert.deepEqual(await first.registry(), registry, 'the first time it waits for the network')
    assert.equal(reads, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), registry, 'and a copy is kept on disk')
    await first.registry()
    assert.equal(reads, 1, 'read lately: no second read')
    // Togle starts again, and the network is slow to answer: the copy on disk answers at once.
    let release
    const slowNet = () => new Promise((resolve) => { release = () => resolve(net()) })
    const second = new RegistryKeeper(file, slowNet, () => clock)
    assert.deepEqual(await second.registry(), registry, 'the list is there without the network')
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    clock += 7 * 60 * 60_000
    // Old in memory: it answers with what it has, and reads again behind.
    online = false
    assert.deepEqual(await second.registry(), registry, 'offline, an old copy still answers')
    // Nothing on disk and no network: an error, so that the list says it could not be loaded.
    const none = new RegistryKeeper(path.join(dir, 'none.json'), net, () => clock)
    await assert.rejects(none.registry(), /offline/)
    // A copy on disk that is not a registry's JSON is no copy.
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json')
    const broken = new RegistryKeeper(path.join(dir, 'broken.json'), net, () => clock)
    await assert.rejects(broken.registry(), /offline/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the commands Togle knows for its own list are for ACP, except the one terminal agent', () => {
  for (const known of KNOWN_TO_START) assert.equal(commandIsAcp(known.command), known.id !== 'aider', known.name)
  assert.equal(new Set(KNOWN_TO_START.map((known) => known.id)).size, KNOWN_TO_START.length)
  assert.match(registryPlatform('win32', 'x64'), /^windows-x86_64$/)
  assert.equal(registryPlatform('darwin', 'arm64'), 'darwin-aarch64')
  assert.equal(registryPlatform('linux', 'x64'), 'linux-x86_64')
})
