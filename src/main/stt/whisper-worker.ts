// Electron utility process: hears clips with whisper.cpp's library itself, where its release has no server (macOS:
// the framework, which has Whisper's functions beside Parakeet's). It decodes as whisper-server does with the
// settings Togle sends it (stt/whisper.ts), so both hear the same. It runs apart from the app, so a crash in native
// code can't take Togle down with it. Started with: <library> <ggml library, or empty> <model file> <use gpu: 1|0>
// <threads>.
import koffi from 'koffi'
import path from 'node:path'

interface Request {
  pcm: Float32Array
  language: string
  prompt: string
  /** Beam search (finished utterances), else greedy (live previews). */
  beam: boolean
}

const [library, ggml, modelPath, gpu, threads] = process.argv.slice(2)
const port = process.parentPort

try {
  // The library registers no compute backends (whisper-server does it in main): where they're libraries of their own
  // (Windows, Linux), they're loaded first. macOS's framework has them built in.
  if (ggml) koffi.load(ggml).func('void ggml_backend_load_all_from_path(const char *dir)')(path.dirname(library))
  const lib = koffi.load(library)
  // Layouts from include/whisper.h (whisper.cpp b5454).
  koffi.struct('whisper_aheads', { n_heads: 'size_t', heads: 'void *' })
  koffi.struct('whisper_context_params', {
    use_gpu: 'bool',
    flash_attn: 'bool',
    gpu_device: 'int',
    dtw_token_timestamps: 'bool',
    dtw_aheads_preset: 'int',
    dtw_n_top: 'int',
    dtw_aheads: 'whisper_aheads',
    dtw_mem_size: 'size_t'
  })
  koffi.struct('whisper_vad_params', {
    threshold: 'float',
    min_speech_duration_ms: 'int',
    min_silence_duration_ms: 'int',
    max_speech_duration_s: 'float',
    speech_pad_ms: 'int',
    samples_overlap: 'float'
  })
  koffi.struct('whisper_full_params', {
    strategy: 'int',
    n_threads: 'int',
    n_max_text_ctx: 'int',
    offset_ms: 'int',
    duration_ms: 'int',
    translate: 'bool',
    no_context: 'bool',
    no_timestamps: 'bool',
    single_segment: 'bool',
    print_special: 'bool',
    print_progress: 'bool',
    print_realtime: 'bool',
    print_timestamps: 'bool',
    token_timestamps: 'bool',
    thold_pt: 'float',
    thold_ptsum: 'float',
    max_len: 'int',
    split_on_word: 'bool',
    max_tokens: 'int',
    debug_mode: 'bool',
    audio_ctx: 'int',
    tdrz_enable: 'bool',
    suppress_regex: 'const char *',
    initial_prompt: 'const char *',
    carry_initial_prompt: 'bool',
    prompt_tokens: 'void *',
    prompt_n_tokens: 'int',
    language: 'const char *',
    detect_language: 'bool',
    suppress_blank: 'bool',
    suppress_nst: 'bool',
    temperature: 'float',
    max_initial_ts: 'float',
    length_penalty: 'float',
    temperature_inc: 'float',
    entropy_thold: 'float',
    logprob_thold: 'float',
    no_speech_thold: 'float',
    greedy: koffi.struct({ best_of: 'int' }),
    beam_search: koffi.struct({ beam_size: 'int', patience: 'float' }),
    new_segment_callback: 'void *',
    new_segment_callback_user_data: 'void *',
    progress_callback: 'void *',
    progress_callback_user_data: 'void *',
    encoder_begin_callback: 'void *',
    encoder_begin_callback_user_data: 'void *',
    abort_callback: 'void *',
    abort_callback_user_data: 'void *',
    logits_filter_callback: 'void *',
    logits_filter_callback_user_data: 'void *',
    grammar_rules: 'void *',
    n_grammar_rules: 'size_t',
    i_start_rule: 'size_t',
    grammar_penalty: 'float',
    vad: 'bool',
    vad_model_path: 'const char *',
    vad_params: 'whisper_vad_params'
  })
  const contextDefaults = lib.func('whisper_context_params whisper_context_default_params()')
  const init = lib.func('void *whisper_init_from_file_with_params(const char *path, whisper_context_params params)')
  const fullDefaults = lib.func('whisper_full_params whisper_full_default_params(int strategy)')
  const full = lib.func('int whisper_full(void *ctx, whisper_full_params params, const float *samples, int n_samples)')
  const segments = lib.func('int whisper_full_n_segments(void *ctx)')
  const segmentText = lib.func('const char *whisper_full_get_segment_text(void *ctx, int i)')
  const noSpeech = lib.func('float whisper_full_get_segment_no_speech_prob(void *ctx, int i)')
  const tokens = lib.func('int whisper_full_n_tokens(void *ctx, int i)')
  const tokenId = lib.func('int whisper_full_get_token_id(void *ctx, int i, int j)')
  const tokenP = lib.func('float whisper_full_get_token_p(void *ctx, int i, int j)')
  const eot = lib.func('int whisper_token_eot(void *ctx)')

  // As whisper-server sets them up (examples/server/server.cpp): flash attention, and for every clip no context from
  // the last one, temperature 0 with its fallback, its thresholds, and segments split at 60 characters.
  const context = contextDefaults()
  context.use_gpu = gpu === '1'
  context.flash_attn = true
  const ctx = init(modelPath, context)
  if (!ctx) throw new Error(`Could not load ${path.basename(modelPath)}`)
  const setUp = (strategy: number): Record<string, unknown> => ({
    ...fullDefaults(strategy),
    n_threads: Number(threads) || 4,
    print_realtime: false,
    print_progress: false,
    print_timestamps: true,
    print_special: false,
    thold_pt: 0.01,
    max_len: 60,
    no_context: true,
    no_timestamps: false,
    token_timestamps: true,
    temperature: 0,
    temperature_inc: 0.2,
    entropy_thold: 2.4,
    logprob_thold: -1,
    no_speech_thold: 0.6,
    greedy: { best_of: 2 },
    beam_search: { beam_size: 5, patience: -1 }
  })
  const greedy = setUp(0)
  const beam = setUp(1)
  const end = eot(ctx) as number
  port.postMessage({ type: 'ready' })

  port.on('message', (e) => {
    const { pcm, language, prompt, beam: useBeam } = e.data as Request
    try {
      const status = full(ctx, { ...(useBeam ? beam : greedy), language, initial_prompt: prompt || null }, pcm, pcm.length) as number
      if (status !== 0) throw new Error(`Whisper failed (${status})`)
      const heard = []
      for (let i = 0, n = segments(ctx) as number; i < n; i++) {
        // The segment's mean log probability over its text tokens, as the server's verbose_json gives it.
        let sum = 0
        const count = tokens(ctx, i) as number
        for (let j = 0; j < count; j++) if ((tokenId(ctx, i, j) as number) < end) sum += Math.log(Math.max(1e-10, tokenP(ctx, i, j) as number))
        heard.push({ text: segmentText(ctx, i) as string, no_speech_prob: noSpeech(ctx, i) as number, avg_logprob: count ? sum / count : 0 })
      }
      port.postMessage({ type: 'result', segments: heard })
    } catch (err) {
      port.postMessage({ type: 'result', error: (err as Error).message })
    }
  })
} catch (err) {
  port.postMessage({ type: 'failed', message: (err as Error).message })
  process.exit(1)
}
