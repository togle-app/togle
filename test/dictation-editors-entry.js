import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

let view
let surface
window.nativeEditorEvents = { enter: 0, tab: 0, paste: 0 }
document.addEventListener('keydown', event => {
  if (event.key === 'Enter') window.nativeEditorEvents.enter++
  if (event.key === 'Tab') window.nativeEditorEvents.tab++
})
document.addEventListener('paste', () => { window.nativeEditorEvents.paste++ })
window.editorFixture = {
  open(doc = '', anchor = doc.length, head = anchor, readOnly = false, editable = true) {
    view?.destroy()
    surface = undefined
    document.getElementById('editor').replaceChildren()
    view = new EditorView({
      parent: document.getElementById('editor'),
      state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(editable),
        EditorView.contentAttributes.of({ 'aria-label': 'Disposable Markdown editor' })
      ] })
    })
    view.focus()
  },
  surface(kind, initial = '') {
    view?.destroy(); view = undefined
    const host = document.getElementById('editor')
    host.replaceChildren()
    if (kind === 'shadow') {
      const root = document.createElement('div')
      host.append(root)
      surface = document.createElement('textarea')
      surface.value = initial
      root.attachShadow({ mode: 'open' }).append(surface)
    } else {
      surface = document.createElement('div')
      surface.contentEditable = kind === 'plaintext' ? 'plaintext-only' : 'true'
      if (kind === 'textbox') surface.setAttribute('role', 'textbox')
      if (kind === 'document') surface.setAttribute('role', 'document')
      if (kind === 'paragraph') surface.innerHTML = '<p><br></p>'
      else surface.textContent = initial
      host.append(surface)
      if (kind === 'blocked-unicode') surface.addEventListener('beforeinput', event => {
        if (event.inputType === 'insertText') event.preventDefault()
      })
      if (kind === 'reject-paste') surface.addEventListener('paste', event => event.preventDefault())
    }
    surface.focus()
    if (surface instanceof HTMLTextAreaElement) surface.setSelectionRange(initial.length, initial.length)
    else {
      const range = document.createRange(); range.selectNodeContents(surface); range.collapse(false)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    }
  },
  text() { return view ? view.state.doc.toString() : surface instanceof HTMLTextAreaElement ? surface.value : surface.innerText },
  select(anchor, head = anchor) { view.dispatch({ selection: { anchor, head } }); view.focus() }
}
