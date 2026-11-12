// A stand-in for an agent that runs in a terminal: it says what it was started with, shows a prompt and answers each line
// typed into it. "exit N" ends it with that code; Ctrl+C ends it as a terminal program does. It reads keys one by one
// (raw mode), as agents in a terminal do.
const args = process.argv.slice(2)
process.stdout.write(`started with ${JSON.stringify(args)}\r\n`)
process.stdout.write('ready> ')
let line = ''
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  for (const key of chunk) {
    if (key === '\x03') {
      process.stdout.write('^C\r\n')
      process.exit(130)
    }
    if (key === '\r' || key === '\n') {
      const said = line
      line = ''
      process.stdout.write(`\r\nheard: ${said}\r\n`)
      const exit = /^exit (\d+)$/.exec(said)
      if (exit) process.exit(Number(exit[1]))
      process.stdout.write('ready> ')
    } else {
      line += key
      process.stdout.write(key)
    }
  }
})
