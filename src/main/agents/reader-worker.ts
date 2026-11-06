import { parentPort, workerData } from 'node:worker_threads'
import { chatAt, exportChats } from './chat-exports'
import { readFileText, setCodePage } from './knowledge'
import type { ReadTask } from './reader'

// Reads one file the user teaches an agent with, or an export of their chats, away from the main thread (see reader.ts).
const task = workerData as ReadTask
const read = (): Promise<unknown> => {
  if (task.task === 'chats') return exportChats(task.file)
  if (task.task === 'chat') return chatAt(task.file, task.id, task.part, task.n)
  setCodePage(task.codePage)
  return readFileText(task.file)
}
read().then(
  (value) => parentPort!.postMessage({ value }),
  (err: unknown) => parentPort!.postMessage({ error: (err as Error).message })
)
