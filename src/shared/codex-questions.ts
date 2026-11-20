/** The identifier shared by Codex Chat and Terminal for one question in an async agent message. */
export interface CodexQuestion {
  id: string
  title: string
  options: string[]
}

interface QuestionReply { questionItemId: string; question: string; answer: string }

const open = '<send_user_message_question_reply>'
const close = '</send_user_message_question_reply>'

export function answerCodexQuestion(question: CodexQuestion, answer: string): string {
  return open + '\n' + JSON.stringify([{ questionItemId: question.id, question: question.title, answer }]) + '\n' + close
}

/** A full Codex reply, possibly after its IDE context. Quoted examples and ordinary user messages stay intact. */
export function codexQuestionReplies(message: string): QuestionReply[] | null {
  let words = message.trim()
  if (words.startsWith('# Context from my IDE setup:\n')) words = words.split('\n## My request for Codex:\n').at(-1)!.trim()
  if (!words.startsWith(open) || !words.endsWith(close)) return null
  try {
    const value: unknown = JSON.parse(words.slice(open.length, -close.length))
    const replies = Array.isArray(value) ? value : [value]
    return replies.length && replies.every(row => row && typeof row.questionItemId === 'string' && typeof row.question === 'string' && typeof row.answer === 'string') ? replies : null
  } catch { return null }
}
