import { useEffect, useState } from 'react'
import type { ModelOption } from '@shared/types'
import type { ModelSource } from '@shared/model-selection'

export interface ModelGroup { source: ModelSource; models: ModelOption[]; error?: string }
const cache = new Map<string, { at: number; task: Promise<ModelOption[]> }>()
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Catalog reads never change the selected account and never send a model prompt. */
export function useModelCatalog(sources: ModelSource[]) {
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const signature = JSON.stringify(sources.map(source => [source.id, source.ready, source.identity, source.label]))
  useEffect(() => {
    let current = true, next = 0
    const snapshot = sources.map(source => ({ source, models: [] } as ModelGroup))
    setGroups(snapshot)
    setLoading(snapshot.some(group => group.source.ready))
    const worker = async (): Promise<void> => {
      while (current && next < snapshot.length) {
        const group = snapshot[next++]
        if (!group.source.ready) continue
        const key = JSON.stringify([group.source.id, group.source.identity])
        let entry = cache.get(key)
        if (!entry || Date.now() - entry.at > 60_000) {
          const task = window.togle.listModels(group.source.id)
          entry = { at: Date.now(), task }; cache.set(key, entry)
          void task.catch(() => { if (cache.get(key)?.task === task) cache.delete(key) })
        }
        try { group.models = await entry.task }
        catch (error) { group.error = errorText(error) }
        if (current) setGroups(snapshot.map(value => ({ ...value })))
      }
    }
    // Bound native SDK startups when many personal/work accounts are connected.
    void Promise.all([worker(), worker()]).then(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [signature, revision])
  return { groups, loading, refresh: () => { for (const source of sources) cache.delete(JSON.stringify([source.id, source.identity])); setRevision(value => value + 1) } }
}

const keyFor = (source: string, model: string): string => JSON.stringify([source, model])

export function ModelPicker({ label, groups, sourceId, model, disabled, inherit, onInherit, onSelect }: {
  label: string
  groups: ModelGroup[]
  sourceId: string
  model: string
  disabled?: boolean
  inherit?: string
  onInherit?: () => void
  onSelect: (source: ModelSource, model: ModelOption) => void
}) {
  const value = onInherit && !model ? '' : keyFor(sourceId, model)
  const present = groups.some(group => group.source.id === sourceId && group.models.some(option => option.id === model))
  const currentSource = groups.find(group => group.source.id === sourceId)?.source
  return <select aria-label={label} value={value} disabled={disabled} onChange={event => {
    if (!event.target.value) { onInherit?.(); return }
    for (const group of groups) {
      const chosen = group.models.find(option => keyFor(group.source.id, option.id) === event.target.value)
      if (chosen) { onSelect(group.source, chosen); return }
    }
  }}>
    {onInherit ? <option value="">{inherit || 'Use the default model'}</option> : <option value="" disabled>Choose a model from your accounts</option>}
    {value && !present && <option value={value}>{model || 'Default model'}{currentSource ? ` · ${currentSource.label}` : ''}{currentSource && !currentSource.ready ? ' · Sign in needed' : ''}</option>}
    {groups.filter(group => group.source.ready && group.models.length).map(group => <optgroup key={group.source.id} label={group.source.label}>
      {group.models.map(option => <option key={option.id} value={keyFor(group.source.id, option.id)}>{option.label}</option>)}
    </optgroup>)}
  </select>
}
