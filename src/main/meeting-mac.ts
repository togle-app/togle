import koffi from 'koffi'
import type { AccessibleRef, MeetingAccessibility } from './meeting-accessibility'

const UTF8 = 0x08000100
const ADDRESS_FIELD = /^(?:address and search bar|search or enter (?:website name|address)|search with .* or enter address|smart search field|urlbar-input|address bar)$/i
const ROLES: Record<string, string> = {
  AXButton: 'button', AXToggleButton: 'toggle button', AXCheckBox: 'check box', AXMenuButton: 'menu button',
  AXToolBar: 'tool bar', AXToolbar: 'tool bar', AXGroup: 'group', AXWebArea: 'web area', AXTabGroup: 'tab group',
  AXTabButton: 'page tab', AXStaticText: 'text', AXLink: 'link', AXImage: 'image',
  AXMenu: 'menu', AXMenuBar: 'menu bar', AXListItem: 'list item', AXTable: 'table', AXOutline: 'tree'
}

/** Calls Apple's accessibility APIs in a worker thread so they use the Togle app's Accessibility permission. */
export function macMeetingAccessibility(): MeetingAccessibility {
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  const trusted = ax.func('bool AXIsProcessTrusted()')
  const application = ax.func('void *AXUIElementCreateApplication(int pid)')
  const timeout = ax.func('int AXUIElementSetMessagingTimeout(void *element, float seconds)')
  const get = ax.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)')
  const getCount = ax.func('int AXUIElementGetAttributeValueCount(void *element, void *attribute, _Out_ intptr_t *size)')
  const getMany = ax.func('int AXUIElementCopyAttributeValues(void *element, void *attribute, intptr_t first, intptr_t max, _Out_ void **values)')
  const makeString = cf.func('void *CFStringCreateWithCString(void *allocator, const char *value, uint32_t encoding)')
  const readString = cf.func('uint8_t CFStringGetCString(void *string, void *buffer, intptr_t size, uint32_t encoding)')
  const typeOf = cf.func('uintptr_t CFGetTypeID(void *value)')
  const stringType = cf.func('uintptr_t CFStringGetTypeID()')()
  const boolType = cf.func('uintptr_t CFBooleanGetTypeID()')()
  const numberType = cf.func('uintptr_t CFNumberGetTypeID()')()
  const urlType = cf.func('uintptr_t CFURLGetTypeID()')()
  const cfUrl = cf.func('void *CFURLGetString(void *url)')
  const boolValue = cf.func('uint8_t CFBooleanGetValue(void *bool)')
  const numberValue = cf.func('uint8_t CFNumberGetValue(void *number, intptr_t type, _Out_ int32_t *value)')
  const arrayCount = cf.func('intptr_t CFArrayGetCount(void *array)')
  const arrayItem = cf.func('void *CFArrayGetValueAtIndex(void *array, intptr_t index)')
  const retain = cf.func('void *CFRetain(void *value)')
  const release = cf.func('void CFRelease(void *value)')
  const equal = cf.func('uint8_t CFEqual(void *a, void *b)')
  const observeType = koffi.proto('void TogleAXChange(void *observer, void *element, void *notification, void *context)')
  const createObserver = ax.func('int AXObserverCreate(int pid, void *callback, _Out_ void **observer)')
  const watchEvent = ax.func('int AXObserverAddNotification(void *observer, void *element, void *event, void *context)')
  const observerSource = ax.func('void *AXObserverGetRunLoopSource(void *observer)')
  const loop = cf.func('void *CFRunLoopGetCurrent()')()
  const addSource = cf.func('void CFRunLoopAddSource(void *loop, void *source, void *mode)')
  const removeSource = cf.func('void CFRunLoopRemoveSource(void *loop, void *source, void *mode)')
  const runLoop = cf.func('int CFRunLoopRunInMode(void *mode, double seconds, uint8_t returnAfterSource)')
  const defaultMode = koffi.decode(cf.symbol('kCFRunLoopDefaultMode'), 'void *')
  const pushPool = objc.func('void *objc_autoreleasePoolPush()')
  const popPool = objc.func('void objc_autoreleasePoolPop(void *pool)')
  const getClass = objc.func('void *objc_getClass(const char *name)')
  const sel = objc.func('void *sel_registerName(const char *name)')
  const send = objc.func('objc_msgSend', 'void *', ['void *', 'void *'])
  const sendIndex = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'uintptr_t'])
  const sendCount = objc.func('objc_msgSend', 'uintptr_t', ['void *', 'void *'])
  const sendInt = objc.func('objc_msgSend', 'int', ['void *', 'void *'])
  const sendBool = objc.func('objc_msgSend', 'uint8_t', ['void *', 'void *'])
  const selectors = Object.fromEntries([
    'sharedWorkspace', 'runningApplications', 'activationPolicy', 'localizedName', 'bundleIdentifier',
    'isActive', 'processIdentifier', 'count', 'objectAtIndex:'
  ].map(key => [key, sel(key)]))
  const attributes = Object.fromEntries([
    'AXWindows', 'AXChildren', 'AXParent', 'AXRole', 'AXSubrole', 'AXTitle', 'AXDescription', 'AXHelp',
    'AXIdentifier', 'AXEnabled', 'AXHidden', 'AXFocused', 'AXMain', 'AXSelected', 'AXValue', 'AXURL',
    'AXTitleChanged', 'AXValueChanged', 'AXUIElementDestroyed'
  ].map(key => [key, makeString(null, key, UTF8)]))

  // Electron loads AppKit before this worker starts. NSWorkspace identifies the user's running GUI apps.
  const workspaceClass = getClass('NSWorkspace')
  if (!workspaceClass) throw new Error('NSWorkspace unavailable.')
  const owned: AccessibleRef[] = []
  const roles = new Map<AccessibleRef, string>()
  let subscription: { observer: unknown; source: unknown; callback: ReturnType<typeof koffi.register> } | undefined
  const take = (raw: unknown): AccessibleRef => {
    const ref = koffi.address(raw)
    owned.push(ref)
    return ref
  }
  const string = (value: unknown): string => {
    if (!value || typeOf(value) !== stringType) return ''
    const buffer = Buffer.alloc(2048)
    if (!readString(value, buffer, buffer.length, UTF8)) return ''
    return buffer.toString('utf8', 0, buffer.indexOf(0))
  }
  const attribute = <T>(ref: AccessibleRef, key: string, map: (value: AccessibleRef) => T): T | undefined => {
    const output = [null]
    if (get(ref, attributes[key], output) !== 0 || !output[0]) return
    try { return map(koffi.address(output[0])) } finally { release(output[0]) }
  }
  const word = (ref: AccessibleRef, key: string) => attribute(ref, key, string) ?? ''
  const flag = (ref: AccessibleRef, key: string): boolean | undefined => attribute(ref, key, value => {
    const type = typeOf(value)
    if (type === boolType) return !!boolValue(value)
    if (type !== numberType) return
    const integer = [0]
    if (numberValue(value, 3, integer)) return !!integer[0] // kCFNumberSInt32Type
  })
  const name = (ref: AccessibleRef) => word(ref, 'AXTitle') || word(ref, 'AXDescription')
  const list = (ref: AccessibleRef, key: string, limit: number): AccessibleRef[] | undefined => {
    const size = [0]
    if (getCount(ref, attributes[key], size) !== 0) return
    const count = Number(size[0])
    const result: AccessibleRef[] = []
    const batch = (start: number, length: number): boolean => {
      const array = [null]
      if (getMany(ref, attributes[key], start, length, array) !== 0 || !array[0]) return false
      try {
        const items = Number(arrayCount(array[0]))
        for (let i = 0; i < items; i++) {
          const item = arrayItem(array[0], i)
          if (item) result.push(take(retain(item)))
        }
        return true
      } finally { release(array[0]) }
    }
    if (count <= 0) return result
    if (count <= limit) return batch(0, count) ? result : undefined
    const head = Math.ceil(limit / 2)
    return batch(0, head) && batch(count - (limit - head), limit - head) ? result : undefined
  }
  const role = (ref: AccessibleRef): string => {
    const found = roles.get(ref)
    if (found !== undefined) return found
    const native = word(ref, 'AXRole')
    let role = ROLES[native] ?? native
    if (native === 'AXRadioButton' || native === 'AXGroup') {
      const subrole = word(ref, 'AXSubrole')
      if (subrole === 'AXTabButton' || subrole === 'AXTab' || native === 'AXRadioButton' &&
          attribute(ref, 'AXParent', parent => word(parent, 'AXRole')) === 'AXTabGroup') role = 'page tab'
    }
    if (native === 'AXTextField' && (ADDRESS_FIELD.test(name(ref)) || ADDRESS_FIELD.test(word(ref, 'AXIdentifier')))) role = 'address bar'
    roles.set(ref, role)
    return role
  }
  const unwatch = () => {
    const old = subscription
    if (!old) return
    subscription = undefined
    removeSource(loop, old.source, defaultMode)
    release(old.observer)
    koffi.unregister(old.callback)
  }

  return {
    applications() {
      if (!trusted()) return
      const pool = pushPool()
      try {
        const workspace = send(workspaceClass, selectors.sharedWorkspace)
        const apps = workspace && send(workspace, selectors.runningApplications)
        if (!apps) return
        const count = Math.min(Number(sendCount(apps, selectors.count)), 150)
        const result: ReturnType<MeetingAccessibility['applications']> = []
        for (let index = 0; index < count; index++) {
          const item = sendIndex(apps, selectors['objectAtIndex:'], index)
          if (!item || sendInt(item, selectors.activationPolicy) === 2) continue
          const pid = sendInt(item, selectors.processIdentifier)
          if (!pid) continue
          const program = string(send(item, selectors.bundleIdentifier)) || string(send(item, selectors.localizedName))
          if (program) result.push({ pid, program, active: !!sendBool(item, selectors.isActive) })
        }
        return result
      } finally { popPool(pool) }
    },
    windows(app) {
      const root = application(app.pid)
      if (!root) return
      timeout(root, 0.2)
      return list(take(root), 'AXWindows', 24)
    },
    children: ref => list(ref, 'AXChildren', 34) ?? [],
    role,
    name,
    help: ref => word(ref, 'AXHelp') || word(ref, 'AXDescription'),
    active: ref => flag(ref, 'AXMain') === true,
    selected: ref => (flag(ref, 'AXSelected') ?? flag(ref, 'AXValue')) === true,
    enabled: ref => flag(ref, 'AXEnabled') !== false,
    showing: ref => flag(ref, 'AXHidden') !== true,
    address(ref) {
      if (role(ref) === 'web area') {
        return attribute(ref, 'AXURL', value => typeOf(value) === urlType ? string(cfUrl(value)) : string(value)) ?? ''
      }
      if (role(ref) !== 'address bar' || flag(ref, 'AXFocused')) return ''
      const url = word(ref, 'AXValue')
      return /^[\w.-]+\.[\w.-]+(?:\/|$)/.test(url) ? 'https://' + url : url
    },
    same: (a, b) => a === b || !!equal(a, b),
    retain: ref => { retain(ref) },
    release: ref => { release(ref) },
    clear() {
      roles.clear()
      for (const ref of owned) release(ref)
      owned.length = 0
    },
    watch(app, ref, changed) {
      const callback = koffi.register((_observer: unknown, element: unknown) => {
        if (subscription && element && equal(element, ref)) changed()
      }, koffi.pointer(observeType))
      const value = [null]
      if (createObserver(app.pid, callback, value) !== 0 || !value[0]) {
        koffi.unregister(callback)
        return false
      }
      const observer = value[0]
      const watching = ['AXTitleChanged', 'AXValueChanged'].map(key => watchEvent(observer, ref, attributes[key], null))
      if (!watching.includes(0)) { release(observer); koffi.unregister(callback); return false }
      watchEvent(observer, ref, attributes.AXUIElementDestroyed, null)
      const source = observerSource(observer)
      addSource(loop, source, defaultMode)
      subscription = { observer, source, callback }
      return true
    },
    unwatch,
    pump() { for (let count = 0; count < 18 && runLoop(defaultMode, 0, 1) === 4; count++) {} },
    dispose() { for (const key of Object.values(attributes)) if (key) release(key) }
  }
}
