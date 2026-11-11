// The program Claude Code starts for a PermissionRequest hook: Togle itself, started as
//   Togle --togle-hook claude-permission --data <Togle's data folder>
// It hands the question to the running Togle, waits for the person's answer, and prints it the way Claude Code takes it.
// Anything that goes wrong prints nothing, which leaves the question to the person where the session runs; so a Togle
// that is not running, or one that cannot prove who it is, costs nothing but a moment.
import { appendFileSync, readFileSync } from 'node:fs'
import { hookOutput } from './claude-permission'
import { askChannel } from './client'
import { channelAddress, readSecret } from './paths'

/** With TOGLE_HOOK_LOG set to a file, each step of the hook is written there: for finding out why a hook did nothing. */
export function logHook(message: string): void {
  const file = process.env.TOGLE_HOOK_LOG
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString().slice(11, 23)} ${message}\n`)
  } catch {
    // Nowhere to write: no matter.
  }
}

/**
 * What Claude Code pipes to the hook. Electron's own `process.stdin` reads nothing from a pipe on Windows (it ends at once,
 * empty), so the input is read from the descriptor itself; where that is not possible (a pipe that has not been filled
 * yet), the stream is read as usual. A terminal is not read: nobody is going to type a request.
 */
export function readInput(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  try {
    return Promise.resolve(readFileSync(0, 'utf8').replace(/^﻿/, ''))
  } catch {
    return readAll(process.stdin)
  }
}

/** Reads all of what arrives on input, for at most `waitMs`. */
export function readAll(input: NodeJS.ReadableStream, waitMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    const done = (): void => {
      clearTimeout(timer)
      resolve(text)
    }
    const timer = setTimeout(done, waitMs)
    input.on('data', (chunk) => {
      text += chunk.toString()
      if (text.length > 5_000_000) done()
    })
    input.on('end', done)
    input.on('error', done)
  })
}

/** What to print for Claude Code, or null for nothing. `args` are what follow `--togle-hook`. */
export async function hookAnswer(args: string[], readInput: () => Promise<string>): Promise<string | null> {
  const dataAt = args.indexOf('--data')
  const dataFolder = dataAt >= 0 ? args[dataAt + 1] : undefined
  logHook(`started: ${args.join(' ')}`)
  if (args[0] !== 'claude-permission' || !dataFolder) return null
  try {
    const input = await readInput()
    logHook(`read ${input.length} characters`)
    const payload: unknown = JSON.parse(input)
    const answer = await askChannel({
      address: channelAddress(dataFolder),
      secret: await readSecret(dataFolder),
      kind: 'claude-permission',
      body: JSON.stringify({ payload }),
      // The hook is registered for ten minutes; this is a little less, so it ends on its own terms.
      timeoutMs: 580_000
    })
    logHook(`answered: ok ${answer.ok}, ${answer.result.slice(0, 120)}`)
    return answer.ok ? hookOutput(JSON.parse(answer.result) as { decision?: unknown; message?: unknown }) : null
  } catch (error) {
    logHook(`nothing printed: ${(error as Error).message}`)
    return null
  }
}
