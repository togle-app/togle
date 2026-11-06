/** Cosine similarity of speaker embeddings, never pitch or transcript text. */
export function voiceSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return -1
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1
}

const unit = (v: Float32Array): Float32Array => {
  const length = Math.sqrt(v.reduce((sum, n) => sum + n * n, 0))
  return length ? Float32Array.from(v, n => n / length) : new Float32Array(v)
}
export function meanVoice(vectors: Float32Array[]): Float32Array {
  const sum = new Float32Array(vectors[0].length)
  for (const vector of vectors) { const v = unit(vector); for (let n = 0; n < sum.length; n++) sum[n] += v[n] }
  return unit(sum)
}
export interface VoiceObservation {
  id: string; at: number; end: number; embedding?: Float32Array
  /** Actual voiced duration, excluding silence. */
  seconds: number
  /** Separate agreeing windows can establish a voice without waiting for another sentence. */
  evidence?: number
  /** A separately verified match to a confirmed, remembered person. */
  identity?: string
  /** A brief second voice or unstable signal can be labeled, but must not train a profile. */
  clean?: boolean
  /** Competing saved identities, including people who have not spoken in this call yet. */
  identities?: { identity: string; score: number }[]
}
export interface VoiceAssignment { id: string; voice: number }
interface Profile { id: number; center: Float32Array; samples: Float32Array[]; observed: Float32Array[]; count: number; seconds: number; identity?: string }
interface Candidate { samples: Float32Array[]; cleanSamples: Float32Array[]; lines: string[]; at: number; seconds: number; evidence: number; cleanSeconds: number; cleanEvidence: number }

/** Multiple exemplars, turn continuity and delayed confirmation of new people. */
export class VoiceClusters {
  private voices: Profile[] = []
  private candidates: Candidate[] = []
  private deferred: { id: string; embedding: Float32Array; at: number; identities?: VoiceObservation['identities'] }[] = []
  private last?: { voice: number; end: number }
  private next = 1
  private seen = new Set<string>()
  private dimension?: number
  get size(): number { return this.voices.length }
  profile(id: number): { samples: Float32Array[]; seconds: number; count: number; identity?: string } | undefined {
    const profile = this.voices.find(profile => profile.id === id)
    return profile && { samples: profile.observed.map(sample => new Float32Array(sample)), seconds: profile.seconds, count: profile.count, identity: profile.identity }
  }
  remember(id: number, identity: string): void { const profile = this.voices.find(profile => profile.id === id); if (profile) profile.identity = identity }
  /** Early captions can recognize a known voice, but never train from repeated prefixes. */
  preview(embedding?: Float32Array, identity?: { id: string; samples: Float32Array[] }, identities?: VoiceObservation['identities']): number | undefined {
    if (!embedding?.length || !embedding.every(Number.isFinite) || voiceSimilarity(embedding, embedding) < .99 || this.dimension && embedding.length !== this.dimension) return
    if (identity) {
      const existing = this.voices.find(profile => profile.identity === identity.id)
      if (existing) return existing.id
      const ranked = this.ranked(embedding), best = ranked[0]
      if (best && !best.profile.identity && best.score >= .60 && best.score - (ranked[1]?.score ?? -1) >= .08) {
        best.profile.identity = identity.id
        return best.profile.id
      }
      if (this.voices.length >= 20 || !identity.samples.length || identity.samples.some(sample => sample.length !== embedding.length)) return
      const profile: Profile = { id: this.next++, center: meanVoice(identity.samples), samples: identity.samples.map(sample => new Float32Array(sample)), observed: [], count: 0, seconds: 0, identity: identity.id }
      this.voices.push(profile); this.dimension ??= embedding.length
      return profile.id
    }
    const ranked = this.ranked(embedding), best = ranked[0]
    return best && this.allowed(best.profile, identities) && best.score >= .64 && best.score - (ranked[1]?.score ?? -1) >= .1 ? best.profile.id : undefined
  }
  breakTurn(): void { this.last = undefined }
  private allowed(profile: Profile, identities?: VoiceObservation['identities']): boolean {
    if (!profile.identity || !identities?.length) return true
    const best = identities[0], own = identities.find(item => item.identity === profile.identity)?.score ?? -1
    return best.identity === profile.identity || best.score < .55 || best.score - own < .06
  }
  private ranked(embedding: Float32Array): { profile: Profile; score: number }[] {
    return this.voices.map(profile => ({ profile, score: Math.max(voiceSimilarity(profile.center, embedding), ...profile.samples.map(sample => voiceSimilarity(sample, embedding))) })).sort((a, b) => b.score - a.score)
  }
  private learn(profile: Profile, embedding: Float32Array, seconds: number): void {
    // A weak continuity match must never move a person's identity toward another voice.
    const weight = Math.min(profile.count, 12)
    profile.center = unit(Float32Array.from(profile.center, (v, i) => v * weight + embedding[i]))
    profile.count++
    profile.seconds += seconds
    profile.samples.push(embedding)
    if (profile.samples.length > 6) profile.samples.splice(1, 1)
    // Saved reference samples help recognition, but must not be enrolled as somebody else's voice
    // if the user corrects an automatic match. Enrollment uses this call's actual observations only.
    profile.observed.push(embedding)
    if (profile.observed.length > 6) profile.observed.splice(1, 1)
  }
  private backfill(profile: Profile): VoiceAssignment[] {
    const assignments: VoiceAssignment[] = []
    this.deferred = this.deferred.filter(item => {
      const ranked = this.ranked(item.embedding), best = ranked[0]
      if (best?.profile === profile && best.score >= .70 && best.score - (ranked[1]?.score ?? -1) >= .12 && this.allowed(profile, item.identities)) {
        assignments.push({ id: item.id, voice: profile.id }); return false
      }
      return true
    })
    this.candidates = this.candidates.filter(candidate => {
      const matches = this.ranked(meanVoice(candidate.samples)), best = matches[0]
      const clean = candidate.cleanSamples.length > 0
      if (best?.profile === profile && best.score >= (clean ? .60 : .68) && best.score - (matches[1]?.score ?? -1) >= (clean ? .08 : .12)) {
        assignments.push(...candidate.lines.map(id => ({ id, voice: profile.id })))
        return false
      }
      return true
    })
    return assignments
  }
  observe(observation: VoiceObservation): VoiceAssignment[] {
    const { id, at, end, embedding, seconds } = observation
    if (this.seen.has(id)) return []
    this.seen.add(id); if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
    this.candidates = this.candidates.filter(candidate => at >= candidate.at && at - candidate.at < 90_000)
    this.deferred = this.deferred.filter(item => at >= item.at)
    if (!embedding?.length || !embedding.every(Number.isFinite) || voiceSimilarity(embedding, embedding) < 0.99 || (this.dimension && embedding.length !== this.dimension) || !Number.isFinite(at) || !Number.isFinite(end) || end < at || !Number.isFinite(seconds) || seconds < 0.7) {
      this.breakTurn(); return []
    }
    this.dimension ??= embedding.length
    const vector = unit(embedding), ranked = this.ranked(vector), best = ranked[0], second = ranked[1]?.score ?? -1
    // Familiar people have confirmed references from other calls. Use that stronger evidence before
    // a continuity hint, and keep two verified identities separate even when their voices are similar.
    if (observation.identity) {
      let profile = this.voices.find(profile => profile.identity === observation.identity)
      if (!profile && best && !best.profile.identity && best.score >= .60 && best.score - second >= .08) profile = best.profile
      if (!profile) {
        if (this.voices.length >= 20) return []
        profile = { id: this.next++, center: vector, samples: [vector], observed: [], count: 0, seconds: 0 }
        this.voices.push(profile)
      }
      profile.identity = observation.identity
      if (seconds >= 1.5 && observation.clean !== false) this.learn(profile, vector, seconds)
      this.last = { voice: profile.id, end }
      return [...this.backfill(profile), { id, voice: profile.id }]
    }
    const strong = best && best.score >= 0.60 && best.score - second >= 0.08
    const previous = this.last && at >= this.last.end - 320 && at - this.last.end <= 1600 ? ranked.find(item => item.profile.id === this.last!.voice) : undefined
    const other = previous ? Math.max(-1, ...ranked.filter(item => item !== previous).map(item => item.score)) : -1
    // A clear match to another voice wins even when people switch without a pause.
    const possible = strong ? best : seconds >= 1.5 && observation.clean !== false && previous && previous.score >= 0.44 && previous.score - other >= 0.04 ? previous : undefined
    const match = possible && this.allowed(possible.profile, observation.identities) ? possible : undefined
    if (match) {
      if (strong && seconds >= 1.5 && observation.clean !== false && best.score >= .68 && best.score - second >= .12) this.learn(match.profile, vector, seconds)
      this.last = { voice: match.profile.id, end }
      const assignments = strong ? this.backfill(match.profile) : []
      return [...assignments, { id, voice: match.profile.id }]
    }
    this.breakTurn()
    if (seconds < 1.5) {
      if (observation.clean !== false) { this.deferred.push({ id, embedding: vector, at, identities: observation.identities }); this.deferred = this.deferred.slice(-512) }
      return []
    }
    const pending = this.candidates.map(candidate => ({ candidate, score: voiceSimilarity(meanVoice(candidate.samples), vector) })).sort((a, b) => b.score - a.score)
    let candidate: Candidate
    if (pending[0]?.score >= 0.60 && pending[0].score - (pending[1]?.score ?? -1) >= 0.08) {
      candidate = pending[0].candidate
      candidate.samples.push(vector); if (candidate.samples.length > 6) candidate.samples.shift()
      if (observation.clean !== false) {
        candidate.cleanSamples.push(vector); if (candidate.cleanSamples.length > 6) candidate.cleanSamples.shift()
        candidate.cleanSeconds += seconds; candidate.cleanEvidence += Math.min(2, observation.evidence ?? 1)
      }
      candidate.lines.push(id); candidate.lines = candidate.lines.slice(-16)
      candidate.seconds += seconds; candidate.evidence += Math.min(2, observation.evidence ?? 1); candidate.at = at
    } else {
      const clean = observation.clean !== false, evidence = Math.min(2, observation.evidence ?? 1)
      candidate = { samples: [vector], cleanSamples: clean ? [vector] : [], lines: [id], at, seconds, evidence, cleanSeconds: clean ? seconds : 0, cleanEvidence: clean ? evidence : 0 }
      this.candidates.push(candidate); if (this.candidates.length > 8) this.candidates.shift()
    }
    if (candidate.evidence < 2 || candidate.seconds < 4 || !candidate.cleanSamples.length) return []
    const center = meanVoice(candidate.cleanSamples), matches = this.ranked(center), closest = matches[0]
    let profile: Profile
    if (closest && this.allowed(closest.profile, observation.identities) && closest.score >= 0.56 && closest.score - (matches[1]?.score ?? -1) >= 0.1) profile = closest.profile
    else {
      // Similar voices used to stay in this grey area forever. Several independent, clean
      // observations that agree with each other much more than an existing voice can establish
      // another person. Repeated prefixes, overlap and a single unusual clip cannot do this.
      const cohesion = Math.min(...candidate.cleanSamples.map(sample => voiceSimilarity(center, sample)))
      const distinct = candidate.cleanSamples.length >= 3 && candidate.cleanSeconds >= 9 &&
        cohesion >= .78 && (!closest || closest.score < .56 && cohesion - closest.score >= .18)
      if ((closest && closest.score >= 0.43 && !distinct) || this.voices.length >= 20) return []
      profile = { id: this.next++, center, samples: [...candidate.cleanSamples], observed: [...candidate.cleanSamples], count: candidate.cleanEvidence, seconds: candidate.cleanSeconds }
      this.voices.push(profile)
    }
    this.candidates = this.candidates.filter(item => item !== candidate)
    this.last = { voice: profile.id, end }
    return [...candidate.lines.map(line => ({ id: line, voice: profile.id })), ...this.backfill(profile)]
  }
  /** An explicit correction combines the acoustic profiles used for future turns too. */
  merge(from: number, into: number): void {
    const source = this.voices.find(profile => profile.id === from), target = this.voices.find(profile => profile.id === into)
    if (!source || !target || source === target) return
    target.samples = [...target.samples, ...source.samples].slice(-6)
    target.observed = [...target.observed, ...source.observed].slice(-6)
    target.center = meanVoice([target.center, source.center]); target.count += source.count; target.seconds += source.seconds
    target.identity ??= source.identity
    this.voices = this.voices.filter(profile => profile !== source)
    if (this.last?.voice === from) this.last.voice = into
  }
}
