// What starts when the `togle` command runs: Electron as plain Node (ELECTRON_RUN_AS_NODE=1) on this file.
import { runCli } from './togle'

const readStdin = (): Promise<string | null> =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null)
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => resolve(text.replace(/^﻿/, '')))
    process.stdin.on('error', () => resolve(null))
  })

void runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: readStdin,
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text)
}).then((code) => {
  process.exitCode = code
})
