import { useSyncExternalStore } from 'react'

// How wide the two panes that can be resized are, and whether the Agents list is hidden. Kept in the page's own storage: they are what
// this person likes on this computer, and come back when Togle does. A bad or missing value is the default one.

/** The navigation's width with its words (the default), and with its icons only (what it is narrowed to). */
export const NAV_DEFAULT = 136
export const NAV_ICONS = 52
export const NAV_MAX = 240
/**
 * The narrowest the navigation is with its words: what its longest button needs (To-do with its count of what waits is 111px, with the
 * navigation's own room 128; this is a little more). A navigation drawn narrower had a word run over its edge.
 */
export const NAV_WORDS_FROM = 132
/** Squeezed narrower than this, the navigation goes to its icons, and dragged out past it the words come back (it stays at its narrowest with words between). */
export const NAV_COLLAPSE_BELOW = 92
/** The Agents list: no narrower than its head and its names need (its label and its two buttons need 248), no wider than this, and the open task keeps DETAIL_MIN at least. */
export const LIST_MIN = 256
export const LIST_MAX = 560
export const DETAIL_MIN = 320
/** Squeezed narrower than this, the Agents list hides, and dragged out past it it is back. */
export const LIST_COLLAPSE_BELOW = 180

export interface Panes {
  /** The navigation's width in px (NAV_ICONS is its icons only). Not set: the default. */
  nav?: number
  /** The Agents list's width in px. Not set: as wide as the stylesheet draws it. */
  list?: number
  /** The Agents list is hidden (it keeps its width for when it is shown again). */
  listHidden?: boolean
}

const KEY = 'togle.panes'

function sane(value: unknown): Panes {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const number = (name: string, least: number, most: number): number | undefined => (typeof raw[name] === 'number' && Number.isFinite(raw[name]) ? Math.min(most, Math.max(least, raw[name] as number)) : undefined)
  const nav = number('nav', NAV_ICONS, NAV_MAX)
  const list = number('list', LIST_MIN, LIST_MAX)
  return { ...(nav === undefined ? {} : { nav }), ...(list === undefined ? {} : { list }), ...(raw.listHidden === true ? { listHidden: true } : {}) }
}

function read(): Panes {
  try {
    return sane(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {
    return {}
  }
}

let panes: Panes = read()
const listeners = new Set<() => void>()

/** Changes what is kept of the panes, now and for the next time. Storage that is not there changes nothing but this run. */
export function setPanes(patch: Partial<Panes>): void {
  panes = sane({ ...panes, ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(panes))
  } catch {
    /* kept for this run only */
  }
  for (const listener of listeners) listener()
}

/** The panes as they are kept, and again when they change (here or in another window of the same page). */
export function usePanes(): Panes {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      const stored = (event: StorageEvent): void => {
        if (event.key !== KEY) return
        panes = read()
        listener()
      }
      window.addEventListener('storage', stored)
      return () => {
        listeners.delete(listener)
        window.removeEventListener('storage', stored)
      }
    },
    () => panes
  )
}

/**
 * The navigation's width: its icons only when it was set so (NAV_ICONS); else its words, never narrower than they need (a width kept
 * by an earlier Togle, from the time a word could run over the edge, is the narrowest now).
 */
export const navPx = (kept: Panes): number => (kept.nav === undefined ? NAV_DEFAULT : kept.nav <= NAV_ICONS ? NAV_ICONS : Math.min(NAV_MAX, Math.max(NAV_WORDS_FROM, kept.nav)))
