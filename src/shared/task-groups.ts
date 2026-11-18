// The person's own arrangement of the Agents list, over the one Togle makes by itself: the groups they made, the names they
// gave groups, and the tasks they moved. Main keeps it (titles.ts); the window shows a change at once, laid over what main
// last sent. Both apply a change with applyGroupChange, so the two agree.

/** A group's key: a made group is `made:<id>`, a project `project:<its folder, as projectKey gives it>`, and `everyday`, `scheduled`. */
export interface TaskGroups {
  /** The groups the person made, in the order they made them. */
  made: { id: string; name: string }[]
  /** Names the person gave Togle's own groups, by key. A made group's name is on it. */
  names: Record<string, string>
  /** The tasks the person moved, by task key: the group they put each in, and the subject there when they dropped it on one. */
  placed: Record<string, { group: string; subject?: string }>
}

export type GroupChange =
  | { kind: 'make'; id: string; name: string }
  /** An empty name gives a group of Togle's back its own name; a made group keeps the one it had. */
  | { kind: 'rename'; group: string; name: string }
  /** A made group goes, and the tasks in it go back to where Togle puts them. */
  | { kind: 'remove'; group: string }
  | { kind: 'place'; task: string; group: string; subject?: string }
  /** The task goes back to where Togle puts it. */
  | { kind: 'put-back'; task: string }
  /** Togle's sorting gave a subject in one of its groups another name: the tasks the person dropped on it follow it. */
  | { kind: 'rename-subject'; group: string; from: string; to: string }

export const NO_GROUPS: TaskGroups = { made: [], names: {}, placed: {} }
export const madeKey = (id: string): string => `made:${id}`

/** A project's key, from its folder: no slash at the end, and on Windows in lower case, where a folder's case does not count. */
export const projectKeyOf = (folder: string, platform: string): string => {
  const clean = folder.replace(/[\\/]+$/, '')
  return platform === 'win32' ? clean.toLowerCase() : clean
}

/** The group Togle puts a task in by itself: Scheduled for a scheduled job, Everyday for work outside any project, else its project. */
export function ownGroupOf(task: { schedule?: string; outsideProject?: boolean; folder: string }, platform: string): string {
  if (task.schedule) return 'scheduled'
  if (task.outsideProject || !task.folder) return 'everyday'
  return `project:${projectKeyOf(task.folder, platform)}`
}

const MOST_MADE = 50
const MOST_PLACED = 2000
const NAME_MOST = 60
const KEY_MOST = 600
const ID = /^[a-z0-9-]{4,40}$/

const nameOf = (text: unknown): string => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, NAME_MOST) : '')
const keyOf = (text: unknown): string => (typeof text === 'string' && text.length > 0 && text.length <= KEY_MOST ? text : '')

/** A change applied. What does not fit (no name, an unknown group, too many) changes nothing, and the same arrangement comes back. */
export function applyGroupChange(groups: TaskGroups, change: GroupChange): TaskGroups {
  switch (change?.kind) {
    case 'make': {
      const name = nameOf(change.name)
      if (!ID.test(String(change.id)) || !name || groups.made.length >= MOST_MADE || groups.made.some((group) => group.id === change.id)) return groups
      return { ...groups, made: [...groups.made, { id: change.id, name }] }
    }
    case 'rename': {
      const group = keyOf(change.group)
      const name = nameOf(change.name)
      if (!group) return groups
      if (group.startsWith('made:')) {
        const id = group.slice('made:'.length)
        if (!name || !groups.made.some((made) => made.id === id)) return groups
        return { ...groups, made: groups.made.map((made) => (made.id === id ? { ...made, name } : made)) }
      }
      const names = { ...groups.names }
      if (name) names[group] = name
      else delete names[group]
      return { ...groups, names }
    }
    case 'remove': {
      const group = keyOf(change.group)
      if (!group.startsWith('made:') || !groups.made.some((made) => madeKey(made.id) === group)) return groups
      return {
        ...groups,
        made: groups.made.filter((made) => madeKey(made.id) !== group),
        placed: Object.fromEntries(Object.entries(groups.placed).filter(([, at]) => at.group !== group))
      }
    }
    case 'place': {
      const task = keyOf(change.task)
      const group = keyOf(change.group)
      if (!task || !group || group === 'scheduled') return groups
      if (group.startsWith('made:') && !groups.made.some((made) => madeKey(made.id) === group)) return groups
      const subject = nameOf(change.subject)
      const placed = { ...groups.placed }
      delete placed[task]
      placed[task] = subject ? { group, subject } : { group }
      const keys = Object.keys(placed)
      for (const old of keys.slice(0, Math.max(0, keys.length - MOST_PLACED))) delete placed[old]
      return { ...groups, placed }
    }
    case 'put-back': {
      const task = keyOf(change.task)
      if (!task || !(task in groups.placed)) return groups
      const placed = { ...groups.placed }
      delete placed[task]
      return { ...groups, placed }
    }
    case 'rename-subject': {
      const group = keyOf(change.group)
      const from = nameOf(change.from).toLowerCase()
      const to = nameOf(change.to)
      if (!group || !from || !to) return groups
      const moved = Object.entries(groups.placed).filter(([, at]) => at.group === group && at.subject?.toLowerCase() === from)
      if (!moved.length) return groups
      return { ...groups, placed: { ...groups.placed, ...Object.fromEntries(moved.map(([task, at]) => [task, { ...at, subject: to }])) } }
    }
    default:
      return groups
  }
}

/** An arrangement as it was kept or sent: only what fits it. */
export function cleanGroups(value: unknown): TaskGroups {
  const given = (value ?? {}) as Partial<Record<keyof TaskGroups, unknown>>
  const made = (Array.isArray(given.made) ? given.made : [])
    .map((item) => item as { id?: unknown; name?: unknown })
    .filter((item) => ID.test(String(item?.id)) && !!nameOf(item?.name))
    .slice(0, MOST_MADE)
    .map((item) => ({ id: String(item.id), name: nameOf(item.name) }))
  const names = Object.fromEntries(
    Object.entries(given.names && typeof given.names === 'object' ? (given.names as Record<string, unknown>) : {})
      .filter(([key, name]) => !!keyOf(key) && !!nameOf(name))
      .map(([key, name]) => [key, nameOf(name)])
  )
  const placed = Object.fromEntries(
    Object.entries(given.placed && typeof given.placed === 'object' ? (given.placed as Record<string, unknown>) : {})
      .map(([task, at]) => [task, (at ?? {}) as { group?: unknown; subject?: unknown }] as const)
      .filter(([task, at]) => !!keyOf(task) && !!keyOf(at.group) && at.group !== 'scheduled')
      .slice(-MOST_PLACED)
      .map(([task, at]) => [task, nameOf(at.subject) ? { group: String(at.group), subject: nameOf(at.subject) } : { group: String(at.group) }])
  )
  return { made, names, placed }
}
