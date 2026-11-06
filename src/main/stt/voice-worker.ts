import { createRequire } from 'node:module'
import { cleanVoiceAudio, normalizeVoice, refineVoiceRegions, splitVoiceTurns } from './voice-audio'

// Both models run on one worker thread, independently of transcription and the UI.
const port = process.parentPort
try {
  const { SpeakerEmbeddingExtractor, OfflineSpeakerDiarization } = createRequire(__filename)('sherpa-onnx-node')
  const embedding = { model: process.argv[2], numThreads: 1, provider: 'cpu', debug: false }
  const extractor = new SpeakerEmbeddingExtractor(embedding)
  const diarizer = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: process.argv[3], windowShiftRatio: .5 }, numThreads: 1, provider: 'cpu', debug: false },
    embedding, clustering: { numClusters: -1, threshold: .5 }, minDurationOn: .2, minDurationOff: .1
  })
  port.postMessage({ type: 'ready' })
  port.on('message', event => {
    const { id, pcm, request, preview } = event.data as { id: string; pcm: Float32Array; request?: number; preview?: boolean }
    try {
      const audio = pcm instanceof Float32Array && normalizeVoice(pcm)
      if (!audio) { port.postMessage({ type: 'result', id, request, seconds: 0, clean: false }); return }
      const regions = refineVoiceRegions(audio, diarizer.process(audio), samples => {
        const normalized = normalizeVoice(samples)
        if (!normalized) return
        const stream = extractor.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: normalized }); stream.inputFinished()
        if (extractor.isReady(stream)) return new Float32Array(extractor.compute(stream, false))
      })
      const voice = cleanVoiceAudio(audio, regions)
      let vector: Float32Array | undefined
      if (voice.samples) {
        const stream = extractor.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: voice.samples }); stream.inputFinished()
        // The owned copy is required by Electron's V8 memory cage.
        if (extractor.isReady(stream)) vector = new Float32Array(extractor.compute(stream, false))
      }
      const boundaries = preview ? [] : splitVoiceTurns(pcm.length, regions)
      const turns = boundaries.length > 1 && boundaries.length <= 32 ? boundaries.map(turn => {
        const selected = cleanVoiceAudio(audio.subarray(turn.from, turn.to), regions.filter((region: { speaker: number }) => region.speaker === turn.speaker).map((region: { start: number; end: number; speaker: number }) => ({ ...region, start: region.start - turn.from / 16000, end: region.end - turn.from / 16000 })))
        let embedding: Float32Array | undefined
        if (selected.samples && !turn.overlap && turn.speaker !== undefined) {
          const stream = extractor.createStream()
          stream.acceptWaveform({ sampleRate: 16000, samples: selected.samples }); stream.inputFinished()
          if (extractor.isReady(stream)) embedding = new Float32Array(extractor.compute(stream, false))
        }
        return { from: turn.from, to: turn.to, embedding, seconds: selected.seconds, evidence: selected.clean && selected.seconds >= 6 ? 2 : 1, clean: selected.clean && !turn.overlap }
      }) : undefined
      port.postMessage({ type: 'result', id, request, embedding: vector, seconds: voice.seconds, evidence: voice.clean && voice.seconds >= 6 ? 2 : 1, clean: voice.clean, mixed: voice.mixed, turns })
    } catch { port.postMessage({ type: 'result', id, request, clean: false }) }
  })
} catch (error) {
  port.postMessage({ type: 'failed', error: (error as Error).message })
}
