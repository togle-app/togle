import { limitName, MANAGE_USAGE_URL, nearestLimit, SAVE_AT, WARN_AT, whenReset } from '@shared/plan'
import type { PlanUsage, PlanWindow } from '@shared/types'
import { Icon } from './Icon'

/** Until when the plan's limit is reached, while it is. */
const limitedUntil = (plan: PlanUsage): number | undefined => (plan.limitedUntil && plan.limitedUntil > Date.now() ? plan.limitedUntil : undefined)

/** "Weekly limit: 42% used, starts over Thu at 4:34 PM." */
function describe(w: PlanWindow): string {
  const name = limitName(w.minutes)
  return `${name[0].toUpperCase()}${name.slice(1)} limit: ${w.usedPercent}% used${w.resetsAt ? `, starts over ${whenReset(w.resetsAt)}` : ''}.`
}

interface NoticeProps {
  plan: PlanUsage
  /** The notices dismissed (each its level and window), which stay away. */
  dismissed: string[]
  onDismiss: (key: string) => void
  /** The model set up under "Other API / local", if any: offered while the plan's limit is reached. */
  apiModel?: string
  onUseApi: () => void
  onKeepModels: () => void
}

/** Near the plan's limit, or at it: what that means for the call. Once per level; dismissed, it stays away. */
export function PlanNotice({ plan, dismissed, onDismiss, apiModel, onUseApi, onKeepModels }: NoticeProps) {
  const nearest = nearestLimit(plan.windows)
  const until = limitedUntil(plan)
  if (!until && (!nearest || nearest.usedPercent < WARN_AT)) return null
  // At the limit, the window that's full and starts over when it ends; the backend may turn requests down with none
  // full (credits used up), and then no window is named.
  const full = plan.windows.filter((w) => w.usedPercent >= 100)
  const reached = until && (full.find((w) => w.resetsAt && Math.abs(w.resetsAt - until) < 60_000) ?? (full.length === 1 ? full[0] : undefined))
  const named = until ? reached || undefined : nearest
  const name = named ? `${limitName(named.minutes)} ` : ''
  const level = until ? 'limit' : plan.saving ? 'saving' : nearest!.usedPercent >= SAVE_AT ? 'full' : 'near'
  // The same notice is the same level of the same window till it starts over, or the same reached limit (its end
  // may be estimated again with every request turned down).
  const windowKey = (l: string): string => `${l}:${nearest?.minutes}:${nearest?.resetsAt}`
  const key = until ? `limit:${plan.limitedSince ?? until}` : windowKey(level)
  if (dismissed.includes(key)) return null
  const startsOver = nearest?.resetsAt ? whenReset(nearest.resetsAt) : ''
  // ChatGPT says a limit is reached, and nothing about the plan's figures: its settings show them.
  if (until && !plan.windows.length) return (
    <div className="notice plan-limit" role="alert">
      <span>
        <strong>Usage limit reached.</strong> Review your ChatGPT plan, or Togle's limit, in ChatGPT settings. Meanwhile Togle doesn't answer on its own (Suggest still tries).{' '}
        <button className="link" onClick={() => void window.togle.openExternal(MANAGE_USAGE_URL)}>Manage usage</button>
        {apiModel && <>{' · '}<button className="link" onClick={onUseApi}>Use {apiModel} meanwhile</button></>}
      </span>
      <button className="dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => onDismiss(key)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  )
  return (
    <div className={`notice ${level === 'near' ? 'info' : ''}`}>
      {until ? (
        <span>
          You've reached your ChatGPT plan's {name}limit. It starts over {whenReset(until)}; until then Togle doesn't answer on its own
          (Suggest still tries).{' '}
          {apiModel && (
            <button className="link" onClick={onUseApi}>
              Use {apiModel} meanwhile
            </button>
          )}
        </span>
      ) : (
        <span>
          You've used {nearest!.usedPercent}% of your ChatGPT plan's {name}limit{startsOver && ` (it starts over ${startsOver})`}.
          {plan.saving && (
            <>
              {' '}
              To make the rest last, every answer now uses {plan.saving}.{' '}
              <button
                className="link"
                onClick={() => {
                  // Without saving, the same level reads as "full": that notice would only repeat this one.
                  onDismiss(windowKey('full'))
                  onKeepModels()
                }}
              >
                Keep my models
              </button>
            </>
          )}
        </span>
      )}
      <button className="dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => onDismiss(key)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

/**
 * The plan's usage in a word or two (the limit closest to running out), with the details on hover. Without figures
 * (Sign in with ChatGPT shows them in ChatGPT's settings), it says the plan is in use and where to manage it.
 */
export function PlanMeter({ plan, listening, onOpen }: { plan: PlanUsage; listening: boolean; onOpen: () => void }) {
  const nearest = nearestLimit(plan.windows)
  if (!nearest) return (
    <span className={`plan-label ${limitedUntil(plan) ? 'limit' : ''}`}>
      {limitedUntil(plan) ? 'Usage limit reached' : 'Using ChatGPT plan'}{' · '}
      <button className="link" title="What Togle uses of your ChatGPT plan, and its limits, in ChatGPT settings" onClick={() => void window.togle.openExternal(MANAGE_USAGE_URL)}>Manage usage</button>
    </span>
  )
  const until = limitedUntil(plan)
  const level = until ? 'limit' : nearest.usedPercent >= SAVE_AT ? 'full' : nearest.usedPercent >= WARN_AT ? 'near' : ''
  const details = [
    ...plan.windows.map(describe),
    ...(plan.call === undefined ? [] : [`${listening ? 'This call so far' : 'The last call'}: ${plan.call < 1 ? 'under 1' : plan.call}%.`]),
    ...(plan.saving ? [`Near the limit, every answer uses ${plan.saving}.`] : [])
  ]
  return (
    <button className={`link plan-meter ${level}`} title={`Your ChatGPT plan. ${details.join(' ')}`} onClick={onOpen}>
      {until ? 'Plan limit reached' : `Plan ${nearest.usedPercent}%`}
    </button>
  )
}

/** Each of the plan's limits with a bar: how much of it is used, and when it starts over. */
export function PlanBars({ plan }: { plan: PlanUsage }) {
  return (
    <div className="plan-bars">
      {plan.windows.map((w) => (
        <div key={w.minutes} className={`plan-bar ${w.usedPercent >= SAVE_AT ? 'full' : w.usedPercent >= WARN_AT ? 'near' : ''}`}>
          <div className="bar">
            <div style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
          </div>
          <span>{describe(w)}</span>
        </div>
      ))}
      {limitedUntil(plan) && <p className="error">Reached: requests are turned down until it starts over.</p>}
    </div>
  )
}
