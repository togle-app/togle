// Agents others made, on their way in: read from a .togle file or a hub, checked, and shown in full before anything is
// installed. The package stays here, not in the window, so what's installed is what was shown.
import { randomUUID } from 'node:crypto'
import type { AgentPreview, AgentSource } from '@shared/types'
import { scanTexts } from './guard'
import { packageTexts, readPackage, type AgentPackage, type PackageFiles } from './package'
import { INLINE_KNOWLEDGE_CHARS } from './store'

// Previews waiting for Install or Cancel: the latest few.
const WAITING = 5
// How much of each document the preview shows.
const EXCERPT = 600

export class Installs {
  private waiting = new Map<string, { pkg: AgentPackage; source: Omit<AgentSource, 'installedAt'> }>()

  /**
   * Reads a package and what the check finds in it, to show; nothing is installed yet. `installedAs` names an agent
   * of mine installed from the same version (its files' hash), if there is one.
   */
  preview(
    files: PackageFiles,
    from: { kind: AgentSource['from']; ref: string; label: string },
    trust: AgentPreview['trust'],
    installedAs?: (hash: string) => { id: string; name: string } | undefined
  ): AgentPreview {
    const { pkg, notes } = readPackage(files)
    const id = randomUUID()
    this.waiting.set(id, { pkg, source: { from: from.kind, ref: from.ref, author: pkg.author, version: pkg.version, hash: pkg.hash } })
    for (const old of this.waiting.keys()) if (this.waiting.size > WAITING) this.waiting.delete(old)
    return {
      id,
      name: pkg.name,
      description: pkg.description,
      author: pkg.author,
      version: pkg.version,
      instructions: pkg.instructions,
      vocabulary: pkg.vocabulary,
      skills: pkg.skills,
      answers: pkg.answers,
      memory: pkg.memory,
      docs: pkg.docs.map((d) => ({ name: d.name, chars: d.text.length, excerpt: d.text.slice(0, EXCERPT) })),
      // Documents too long to go into each request are studied once it's installed: a request of my plan each.
      studies: pkg.docs.reduce((n, d) => n + d.text.length, 0) > INLINE_KNOWLEDGE_CHARS ? pkg.docs.length : 0,
      findings: scanTexts(packageTexts(pkg)),
      installedAs: installedAs?.(pkg.hash),
      from: from.label,
      trust,
      notes
    }
  }

  /** The package shown, to install, unless the check blocks it; it waits no more either way. */
  take(id: string): { pkg: AgentPackage; source: AgentSource } {
    const waiting = this.waiting.get(id)
    if (!waiting) throw new Error('Open the agent again to install it.')
    this.waiting.delete(id)
    const blocked = scanTexts(packageTexts(waiting.pkg)).find((f) => f.level === 'danger')
    if (blocked) throw new Error(`Togle won't install this agent: it ${blocked.what}.`)
    return { pkg: waiting.pkg, source: { ...waiting.source, installedAt: Date.now() } }
  }
}
