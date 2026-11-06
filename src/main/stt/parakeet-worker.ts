// Electron utility process: transcribes clips with NVIDIA's Parakeet TDT v3 through whisper.cpp's Parakeet
// library (parakeet.dll, libparakeet.so, or macOS's framework). It runs apart from the app, so a crash in native
// code can't take Togle down with it. Started with: <library> <ggml library, or empty> <model file> <use gpu: 1|0>.
// Its working folder is the library's, which is where ggml looks for its CPU and CUDA backends.
import koffi from 'koffi'
import path from 'node:path'

interface Request {
  id: number
  pcm: Float32Array
}

const [library, ggml, modelPath, gpu] = process.argv.slice(2)
const port = process.parentPort

try {
  // The library doesn't register compute backends itself (parakeet-cli does it in main): without this,
  // loading the model fails an assertion and the process dies. macOS's framework has its backends built in.
  if (ggml) koffi.load(ggml).func('void ggml_backend_load_all_from_path(const char *dir)')(path.dirname(library))
  const lib = koffi.load(library)
  // Layouts from include/parakeet.h (whisper.cpp b5454).
  koffi.struct('parakeet_context_params', { use_gpu: 'bool', gpu_device: 'int' })
  koffi.struct('parakeet_full_params', {
    strategy: 'int',
    n_threads: 'int',
    offset_ms: 'int',
    duration_ms: 'int',
    no_context: 'bool',
    audio_ctx: 'int',
    new_segment_callback: 'void *',
    new_segment_callback_user_data: 'void *',
    new_token_callback: 'void *',
    new_token_callback_user_data: 'void *',
    progress_callback: 'void *',
    progress_callback_user_data: 'void *',
    encoder_begin_callback: 'void *',
    encoder_begin_callback_user_data: 'void *',
    abort_callback: 'void *',
    abort_callback_user_data: 'void *'
  })
  const init = lib.func('void *parakeet_init_from_file_with_params(const char *path, parakeet_context_params params)')
  const defaults = lib.func('parakeet_full_params parakeet_full_default_params(int strategy)')
  const full = lib.func('int parakeet_full(void *ctx, parakeet_full_params params, const float *samples, int n_samples)')
  const segments = lib.func('int parakeet_full_n_segments(void *ctx)')
  const segmentText = lib.func('const char *parakeet_full_get_segment_text(void *ctx, int i)')
  const tokens = lib.func('int parakeet_full_n_tokens(void *ctx, int i)')
  const tokenP = lib.func('float parakeet_full_get_token_p(void *ctx, int i, int j)')

  const ctx = init(modelPath, { use_gpu: gpu === '1', gpu_device: 0 })
  if (!ctx) throw new Error(`Could not load ${path.basename(modelPath)}`)
  const params = defaults(0)
  params.n_threads = 4
  params.no_context = true
  port.postMessage({ type: 'ready' })

  port.on('message', (e) => {
    const { id, pcm } = e.data as Request
    try {
      const status = full(ctx, params, pcm, pcm.length) as number
      if (status !== 0) throw new Error(`Parakeet failed (${status})`)
      let text = ''
      let sum = 0
      let count = 0
      for (let i = 0, n = segments(ctx) as number; i < n; i++) {
        text += segmentText(ctx, i) as string
        for (let j = 0, m = tokens(ctx, i) as number; j < m; j++, count++) sum += tokenP(ctx, i, j) as number
      }
      // Mean token probability: low means it was unsure what it heard (poor pronunciation, noise).
      port.postMessage({ type: 'result', id, text, confidence: count ? sum / count : 0 })
    } catch (err) {
      port.postMessage({ type: 'result', id, error: (err as Error).message })
    }
  })
} catch (err) {
  port.postMessage({ type: 'failed', message: (err as Error).message })
  process.exit(1)
}
