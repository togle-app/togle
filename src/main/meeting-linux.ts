import { readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import koffi from 'koffi'
import type { AccessibleRef, MeetingAccessibility } from './meeting-accessibility'

const ACTIVE = 1, DEFUNCT = 6, ENABLED = 8, FOCUSED = 12, SELECTED = 23, SHOWING = 25
const WINDOWS = new Set(['window', 'frame', 'dialog'])
const DOCUMENTS = new Set(['document web', 'document frame', 'document'])
const URL_FIELD = /^(?:address and search bar|search or enter address|search with .* or enter address|smart search field|address bar)$/i
const MIC_EVENTS = [
  'object:property-change:accessible-name', 'object:property-change:accessible-description',
  'object:state-changed:checked', 'object:state-changed:pressed', 'object:state-changed:enabled', 'object:state-changed:defunct'
]

/** AT-SPI works with the session desktop on X11 and Wayland. A missing bus or inaccessible app is handled by the caller. */
export function linuxMeetingAccessibility(): MeetingAccessibility {
  const atspi = koffi.load('libatspi.so.0')
  const objects = koffi.load('libgobject-2.0.so.0')
  const glib = koffi.load('libglib-2.0.so.0')
  const init = atspi.func('int atspi_init()')
  const exit = atspi.func('int atspi_exit()')
  const timeout = atspi.func('void atspi_set_timeout(int value, int startup)')
  const desktop = atspi.func('void *atspi_get_desktop(int index)')
  const count = atspi.func('int atspi_accessible_get_child_count(void *object, void *error)')
  const child = atspi.func('void *atspi_accessible_get_child_at_index(void *object, int index, void *error)')
  const pid = atspi.func('uint32_t atspi_accessible_get_process_id(void *object, void *error)')
  const roleName = atspi.func('void *atspi_accessible_get_role_name(void *object, void *error)')
  const getName = atspi.func('void *atspi_accessible_get_name(void *object, void *error)')
  const attributes = atspi.func('void *atspi_accessible_get_attributes(void *object, void *error)')
  const clearCache = atspi.func('void atspi_accessible_clear_cache(void *object)')
  const description = atspi.func('void *atspi_accessible_get_description(void *object, void *error)')
  const stateSet = atspi.func('void *atspi_accessible_get_state_set(void *object)')
  const contains = atspi.func('int atspi_state_set_contains(void *set, int state)')
  const document = atspi.func('void *atspi_accessible_get_document_iface(void *object)')
  const documentAttribute = atspi.func('void *atspi_document_get_document_attribute_value(void *document, const char *name, void *error)')
  const textbox = atspi.func('void *atspi_accessible_get_text_iface(void *object)')
  const text = atspi.func('void *atspi_text_get_text(void *object, int from, int to, void *error)')
  const retain = objects.func('void *g_object_ref(void *object)')
  const release = objects.func('void g_object_unref(void *object)')
  const free = glib.func('void g_free(void *memory)')
  const freeAttributes = glib.func('void g_hash_table_unref(void *table)')
  const iterate = glib.func('int g_main_context_iteration(void *context, int mayBlock)')
  const event = koffi.struct('TogleAtspiEventStart', { name: 'str', source: 'void *' })
  const callbackType = koffi.proto('void TogleAtspiChange(void *event, void *data)')
  const listener = atspi.func('void *atspi_event_listener_new(void *callback, void *data, void *destroy)')
  const register = atspi.func('int atspi_event_listener_register_with_app(void *listener, const char *kind, void *properties, void *application, void *error)')
  const deregister = atspi.func('int atspi_event_listener_deregister(void *listener, const char *kind, void *error)')

  // Keep remote accessibility requests bounded if a provider stops responding.
  timeout(175, 600)
  let initialized = false
  const owned: AccessibleRef[] = []
  const roles = new Map<AccessibleRef, string>()
  let subscription: { callback: ReturnType<typeof koffi.register>; inside: AccessibleRef; events: string[] } | undefined
  const take = (raw: unknown): AccessibleRef | undefined => {
    if (!raw) return
    const ref = koffi.address(raw)
    owned.push(ref)
    return ref
  }
  const string = (raw: unknown): string => {
    if (!raw) return ''
    try { return String(koffi.decode(raw, 'char', -1) ?? '').slice(0, 2048) }
    finally { free(raw) }
  }
  const name = (ref: AccessibleRef) => string(getName(ref, null))
  const has = (ref: AccessibleRef, state: number) => {
    const set = stateSet(ref)
    if (!set) return false
    try { return !!contains(set, state) } finally { release(set) }
  }
  const children = (ref: AccessibleRef, limit: number, complete = false): AccessibleRef[] | undefined => {
    if (has(ref, DEFUNCT)) return
    const size = count(ref, null)
    if (size < 0) return
    const refs: AccessibleRef[] = []
    const half = Math.ceil(limit / 2)
    for (let index = 0; index < size && refs.length < limit; index++) {
      if (index === half && size > limit) index = size - (limit - half)
      const next = take(child(ref, index, null))
      if (next) refs.push(next)
      else if (complete) return
    }
    return refs
  }
  const role = (ref: AccessibleRef): string => {
    const known = roles.get(ref)
    if (known !== undefined) return known
    const role = string(roleName(ref, null))
    const normalized = role === 'entry' && URL_FIELD.test(name(ref)) ? 'address bar' : role
    roles.set(ref, normalized)
    return normalized
  }
  const unwatch = () => {
    const old = subscription
    if (!old) return
    subscription = undefined
    for (const event of old.events) deregister(old.inside, event, null)
    release(old.inside)
    koffi.unregister(old.callback)
  }

  return {
    applications() {
      if (!initialized) {
        initialized = init() < 2
        if (!initialized) return
      }
      const root = take(desktop(0))
      if (!root) return
      return children(root, 90)?.flatMap(root => {
        const processId = pid(root, null)
        if (!processId) return []
        let program: string
        try { program = basename(readlinkSync(`/proc/${processId}/exe`)) }
        catch { program = name(root) }
        return [{ pid: processId, program, root }]
      })
    },
    windows: app => app.root === undefined ? undefined : children(app.root, 24, true)?.filter(ref => WINDOWS.has(role(ref))),
    children(ref) {
      const found = children(ref, 34)
      if (!found || found.length || !WINDOWS.has(role(ref))) return found ?? []
      // Chromium exposes children lazily when an accessibility client asks for the frame's attributes.
      const table = attributes(ref, null)
      if (table) freeAttributes(table)
      clearCache(ref)
      return children(ref, 34) ?? []
    },
    role,
    name,
    help: ref => string(description(ref, null)),
    active: ref => has(ref, ACTIVE),
    selected: ref => has(ref, SELECTED),
    enabled: ref => has(ref, ENABLED),
    showing: ref => has(ref, SHOWING),
    address(ref) {
      if (DOCUMENTS.has(role(ref))) {
        const doc = document(ref)
        if (!doc) return ''
        try { return string(documentAttribute(doc, 'DocURL', null)) || string(documentAttribute(doc, 'URI', null)) }
        finally { release(doc) }
      }
      // Only the named address bar in browser chrome, and only when the user is not editing it.
      if (role(ref) !== 'address bar' || has(ref, FOCUSED)) return ''
      const field = textbox(ref)
      if (!field) return ''
      let address: string
      try { address = string(text(field, 0, -1, null)) } finally { release(field) }
      return /^[\w.-]+\.[\w.-]+(?:\/|$)/.test(address) ? 'https://' + address : address
    },
    same: (a, b) => a === b,
    retain: ref => { retain(ref) },
    release: ref => { release(ref) },
    clear() {
      roles.clear()
      for (const ref of owned) release(ref)
      owned.length = 0
    },
    watch(app, ref, changed) {
      if (!app.root) return false
      const callback = koffi.register((raw: unknown) => {
        if (!subscription || !raw) return
        const { source } = koffi.decode(raw, event) as { source: unknown }
        if (source && koffi.address(source) === ref) changed()
      }, koffi.pointer(callbackType))
      const raw = listener(callback, null, null)
      if (!raw) { koffi.unregister(callback); return false }
      const inside = koffi.address(raw)
      subscription = { inside, callback, events: [] }
      for (const name of MIC_EVENTS) {
        if (register(inside, name, null, app.root, null)) subscription.events.push(name)
      }
      if (subscription.events.includes(MIC_EVENTS[0])) return true
      unwatch()
      return false
    },
    unwatch,
    pump() { for (let count = 0; count < 18 && iterate(null, 0); count++) {} },
    dispose() { if (initialized) exit() }
  }
}
