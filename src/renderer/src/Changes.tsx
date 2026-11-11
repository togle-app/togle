import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangedFile, Changes as ChangesResult } from '@shared/runner'
import { Icon } from './Icon'

const api = window.togle

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

const STATUS_WORD: Record<ChangedFile['status'], string> = { modified: 'changed', added: 'added', new: 'new', deleted: 'deleted', renamed: 'renamed' }

/** The diff cut into one piece for each file, found by the path its header ends with. */
function piecesOf(diff: string): { header: string; text: string }[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((piece) => piece.startsWith('diff --git '))
    .map((piece) => ({ header: piece.slice(0, piece.indexOf('\n') === -1 ? piece.length : piece.indexOf('\n')), text: piece }))
}

/** What differs from the last commit in the folder a task works in: the files, and what changed in each. */
export function Changes({ taskKey, title, folder, onBack }: { taskKey: string; title: string; folder: string; onBack: () => void }) {
  const [result, setResult] = useState<ChangesResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setResult(await api.runnerChanges(taskKey))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [taskKey])
  useEffect(() => {
    void load()
  }, [load])

  const pieces = useMemo(() => piecesOf(result?.diff ?? ''), [result])
  const shown = result?.files.find((file) => file.path === picked) ?? result?.files[0]
  const piece = shown ? pieces.find((candidate) => candidate.header.endsWith(` b/${shown.path}`)) : undefined

  return (
    <div className="changes" aria-label="Changes">
      <header className="task-header">
        <button className="ghost small tasks-back-to-task" onClick={onBack} aria-label="Back to the task">
          <Icon name="back" size={14} />
        </button>
        <div className="task-title">
          <h2 title={title}>Changes in {baseName(folder)}</h2>
          <p>{title}</p>
        </div>
        <div className="task-actions">
          <button className="small" disabled={loading} onClick={() => void load()}>
            {loading ? 'Reading…' : 'Read again'}
          </button>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && !result.git && <p className="hint changes-problem">{result.problem}</p>}
      {result?.git && (
        <>
          <p className="hint">
            Everything in this folder that differs from the last commit{result.branch ? ` on ${result.branch}` : ''}. It can include changes that did not come from the agent.
          </p>
          {!result.files.length && <p className="empty">Nothing differs from the last commit.</p>}
          {!!result.files.length && (
            <div className="changes-body">
              <ul className="changes-files" aria-label="Files">
                {result.files.map((file) => (
                  <li key={file.path}>
                    <button className={`changes-file ${shown?.path === file.path ? 'on' : ''}`} data-status={file.status} aria-current={shown?.path === file.path ? 'true' : undefined} onClick={() => setPicked(file.path)}>
                      <span className="changes-status">{STATUS_WORD[file.status]}</span>
                      <span className="changes-path" title={file.path}>
                        {file.path}
                      </span>
                      {file.added !== null && (
                        <span className="changes-count">
                          <span className="add">+{file.added}</span> <span className="del">−{file.removed ?? 0}</span>
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <pre className="changes-diff" aria-label={shown ? `Changes in ${shown.path}` : 'Changes'}>
                {piece ? piece.text.split('\n').map((line, at) => <DiffLine key={at} line={line} />) : <span className="diff-line meta">{shown ? 'There is nothing to show for this file.' : ''}</span>}
              </pre>
            </div>
          )}
          {result.truncated && <p className="hint">The changes are long, so the last files are not shown. A diff tool shows all of them.</p>}
        </>
      )}
    </div>
  )
}

function DiffLine({ line }: { line: string }) {
  const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'plain'
  return (
    <span className={`diff-line ${kind}`}>
      {line}
      {'\n'}
    </span>
  )
}
