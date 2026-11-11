import { useState } from 'react'
import type { AIProfile, Lane, ModelOption, ReasoningEffort, Settings } from '@shared/types'
import type { SettingsPatch } from '@shared/api'
import { effectiveAI, AI_TASKS } from '@shared/preferences'
import { PRESETS, presetProfile, profileSettings } from '@shared/ai-presets'
import type { ModelSource } from '@shared/model-selection'
import { useConnections } from './Connections'
import { ModelPicker, useModelCatalog } from './ModelPicker'
import { Row, Section, Toggle } from './Rows'
import { openSettings } from './open-settings'

const efforts: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const message = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const effortFor = (model: ModelOption, wanted: ReasoningEffort): ReasoningEffort => !model.reasoningLevels?.length || model.reasoningLevels.includes(wanted) ? wanted : model.defaultReasoning || model.reasoningLevels[0]
/** Why a preset can't be used, said on the preset itself (a tooltip alone hid it): the plan to connect, or what failed. */
const presetProblem = (problem: string): string => {
  const plan = /^Connect a (Claude|ChatGPT)/.exec(problem)?.[1]
  return plan ? `Connect ${plan} under AI account first.` : problem
}

/** Shared by General and each agent. Choosing a recipe saves all four routes together. */
export function ModelSettings({ settings, save, agent = false }: { settings: Settings; save: (patch: SettingsPatch) => Promise<unknown>; agent?: boolean }) {
  const connections = useConnections(), catalog = useModelCatalog(connections.sources)
  const groups = catalog.groups.map(group => {
    const connection = connections.connections.find(connection => connection.id === group.source.id)
    return connection?.model && !group.models.some(model => model.id === connection.model) ? { ...group, models: [{ id: connection.model, label: connection.model }, ...group.models] } : group
  })
  const profile = effectiveAI(settings, undefined, id => connections.sources.find(source => source.id === id)?.provider || settings.provider)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const deep = profile.tasks.deep, selected = connections.sources.find(source => source.id === deep.sourceId)
  const ready = Object.values(profile.tasks).every(task => connections.sources.some(source => source.id === task.sourceId && source.ready))
  const preferred: Partial<Record<'claude' | 'chatgpt', string>> = {}
  for (const lane of ['deep', 'quick', 'vision', 'background'] as const) {
    const source = connections.sources.find(source => source.id === profile.tasks[lane].sourceId)
    if (source?.subscription && source.provider !== 'compat' && !preferred[source.provider]) preferred[source.provider] = source.id
  }
  const presetProviders = (['claude', 'chatgpt'] as const).filter(provider => profile.preset === 'mixed' || profile.preset === (provider === 'claude' ? 'claude' : 'codex'))
  const apply = async (next: AIProfile): Promise<void> => {
    setBusy(true); setError('')
    try { await save(profileSettings(next, groups.length ? groups : connections.sources.map(source => ({ source, models: [] })))) }
    catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  const pick = (source: ModelSource, model: ModelOption, lane?: Lane): void => {
    const task = (role: Lane) => ({ sourceId: source.id, model: model.id, effort: effortFor(model, profile.tasks[role].effort) })
    void apply({ tasks: lane ? { ...profile.tasks, [lane]: task(lane) } : Object.fromEntries(AI_TASKS.map(({ lane }) => [lane, task(lane)])) as AIProfile['tasks'] })
  }
  // Tasks set apart in Advanced: one model for all of them, from the list above, would replace them.
  const custom = new Set(Object.values(profile.tasks).map(task => `${task.sourceId} ${task.model}`)).size > 1
  return <Section id={agent ? 'agent-models' : 'settings-models'} title={agent ? 'AI models' : 'Which AI answers'} state={<span className={`state ${ready ? 'ok' : 'warn'}`}>{ready ? 'Connected' : 'Check connections'}</span>}
    note={agent ? undefined : 'Every agent uses this unless you change it in that agent’s settings.'}>
    <Row stacked name="Model" note={!selected ? 'Connect a plan, an API key or a local server under AI account.' : custom ? `Detailed answers use ${selected.label}. Picking a model here uses it for every task, replacing your choices under Advanced.` : `Suggestions and answers use ${selected.label}.`}>
      <ModelPicker label={agent ? 'Agent model' : 'Default model'} groups={groups} sourceId={deep.sourceId} model={deep.model} disabled={busy} onSelect={(source, model) => pick(source, model)} />
    </Row>
    {agent && <div className="model-status"><button className="link" onClick={() => openSettings('ai')}>Manage accounts in App settings</button></div>}
    <details className="more model-options"><summary>Advanced: presets, and a model for each task</summary>
    <div className="model-presets"><span className="hint">Presets</span><div className="preset-choices">{PRESETS.map(preset => {
      let recipe: AIProfile | undefined, problem = ''
      try { recipe = presetProfile(preset.id, groups, preferred) } catch (error) { problem = message(error) }
      return <button key={preset.id} className={`ghost preset-choice ${profile.preset === preset.id ? 'selected' : ''}`} aria-label={`Use ${preset.label} preset`} aria-pressed={profile.preset === preset.id} title={problem || preset.note} disabled={busy || !recipe} onClick={() => recipe && void apply(recipe)}>{preset.label}{problem ? <span className="preset-problem">{presetProblem(problem)}</span> : <span>{preset.note}</span>}</button>
    })}</div></div>
    {presetProviders.some(provider => connections.accounts.filter(account => account.provider === provider).length > 1) && <details className="more preset-accounts"><summary>Accounts for this preset</summary>
      <p className="hint">Choose work or personal accounts for this recipe.</p>
      {presetProviders.map(provider => {
        const accounts = connections.accounts.filter(account => account.provider === provider)
        if (!accounts.length) return null
        return <Row stacked key={provider} name={provider === 'claude' ? 'Claude account' : 'ChatGPT account'}><select aria-label={provider === 'claude' ? 'Preset Claude account' : 'Preset ChatGPT account'} value={preferred[provider] || accounts.find(account => account.signedIn)?.id || accounts[0].id} disabled={busy} onChange={event => {
          const next = { ...preferred, [provider]: event.target.value }
          try { void apply(presetProfile(profile.preset!, groups, next)) } catch (error) { setError(message(error)) }
        }}>{accounts.map(account => <option key={account.id} value={account.id} disabled={!account.signedIn}>{connections.sources.find(source => source.id === account.id)?.label}</option>)}</select></Row>
      })}
    </details>}
    <dl className="ai-recipe">{AI_TASKS.map(({ lane, label }) => {
      const task = profile.tasks[lane], group = groups.find(group => group.source.id === task.sourceId)
      const model = group?.models.find(model => model.id === task.model)
      return <div key={lane}><dt>{label}</dt><dd>{model?.label || task.model || 'Choose a model'}{new Set(Object.values(profile.tasks).map(task => task.sourceId)).size > 1 && <span title={group?.source.label}>{group?.source.label.split(' · ')[0] || 'Connection unavailable'}</span>}</dd></div>
    })}</dl>
    {catalog.loading && <p className="hint model-status" role="status">Loading models…</p>}
    <div className="task-models">
      <button className="ghost small" disabled={catalog.loading} onClick={catalog.refresh}>Refresh the list of models</button>
      {AI_TASKS.map(({ lane, label }) => {
        const task = profile.tasks[lane], group = groups.find(group => group.source.id === task.sourceId), model = group?.models.find(model => model.id === task.model)
        const levels = model?.reasoningLevels?.length ? model.reasoningLevels : efforts
        return <div className="task-model" key={lane}>
          <Row stacked name={label}><ModelPicker label={`${label} model`} groups={groups} sourceId={task.sourceId} model={task.model} disabled={busy} onSelect={(source, model) => pick(source, model, lane)} /></Row>
          <Row name="Thinking"><select aria-label={`${label} reasoning`} value={task.effort} disabled={busy} onChange={event => void apply({ tasks: { ...profile.tasks, [lane]: { ...task, effort: event.target.value as ReasoningEffort } } })}>{(levels.includes(task.effort) ? levels : [task.effort, ...levels]).map(effort => <option key={effort}>{effort}</option>)}</select></Row>
          {!!model?.fast && <Toggle name="Fast mode" note={model.fast} checked={!!task.fast} onChange={fast => void apply({ tasks: { ...profile.tasks, [lane]: { ...task, fast } } })} />}
        </div>
      })}
      {groups.filter(group => group.error).map(group => <p className="error" key={group.source.id}>{group.source.label}: {group.error}</p>)}
    </div>
    </details>
    {(error || connections.error) && <p className="error" role="alert">{error || connections.error}</p>}
  </Section>
}
