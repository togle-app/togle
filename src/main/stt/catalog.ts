// What Togle downloads to hear calls on this PC, for each system: whisper.cpp's own build (the release Togle is
// measured with) and the models. Each file's SHA-256 is checked before anything in it is used.

/** A file to download: where from, how big, and its SHA-256. */
export interface Download {
  url: string
  bytes: number
  sha256: string
}

/** whisper.cpp built for one system: the archive, the folder in it that has the programs and libraries, and what runs them. */
export interface EngineBuild extends Download {
  id: string
  /** The folder in the archive that holds whisper-server (or, on macOS, the framework) and its libraries. */
  dir: string
  /** whisper-server's file name; none on macOS, where Whisper runs from the framework itself. */
  server?: string
  /** The library with Parakeet's functions (and on macOS Whisper's too), and the one that loads the compute backends. */
  library: string
  ggml?: string
  /** Built for an NVIDIA GPU (CUDA) or Apple's (Metal). */
  gpu: boolean
}

export const RELEASE = 'b5454'
const RELEASES = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`

const ENGINES: Record<string, EngineBuild> = {
  'win-cuda': {
    id: 'win-cuda',
    url: `${RELEASES}/whisper-bin-win-cuda-12.4.0-x64.zip`,
    bytes: 684913404,
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    dir: 'Release',
    server: 'whisper-server.exe',
    library: 'parakeet.dll',
    ggml: 'ggml.dll',
    gpu: true
  },
  'win-cpu': {
    id: 'win-cpu',
    url: `${RELEASES}/whisper-bin-x64.zip`,
    bytes: 8928640,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    dir: 'Release',
    server: 'whisper-server.exe',
    library: 'parakeet.dll',
    ggml: 'ggml.dll',
    gpu: false
  },
  'win-arm64': {
    id: 'win-arm64',
    url: `${RELEASES}/whisper-bin-win-cpu-arm64.zip`,
    bytes: 4371193,
    sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d',
    dir: 'Release',
    server: 'whisper-server.exe',
    library: 'parakeet.dll',
    ggml: 'ggml.dll',
    gpu: false
  },
  'linux-x64': {
    id: 'linux-x64',
    url: `${RELEASES}/whisper-bin-ubuntu-x64.tar.gz`,
    bytes: 10364195,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
    dir: 'whisper-bin-ubuntu-x64',
    server: 'whisper-server',
    library: 'libparakeet.so',
    ggml: 'libggml.so',
    gpu: false
  },
  'linux-arm64': {
    id: 'linux-arm64',
    url: `${RELEASES}/whisper-bin-ubuntu-arm64.tar.gz`,
    bytes: 4608377,
    sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149',
    dir: 'whisper-bin-ubuntu-arm64',
    server: 'whisper-server',
    library: 'libparakeet.so',
    ggml: 'libggml.so',
    gpu: false
  },
  // One library for Apple silicon and Intel, with Metal: Whisper's functions and Parakeet's.
  mac: {
    id: 'mac',
    url: `${RELEASES}/whisper-${RELEASE}-xcframework.zip`,
    bytes: 65816082,
    sha256: 'e57f8c48933000acabc13bb913fbe82805d483a2deff692cc6738836bd92393b',
    dir: 'build-apple/whisper.xcframework/macos-arm64_x86_64/whisper.framework/Versions/A',
    library: 'whisper',
    gpu: true
  }
}

/** A model, and the file it's kept as. */
export interface ModelFile extends Download {
  file: string
}

const HF = 'https://huggingface.co'
export const MODELS = {
  parakeet: {
    file: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin',
    url: `${HF}/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q8_0.bin`,
    bytes: 668757119,
    sha256: '4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e'
  },
  'whisper-turbo': {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`,
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  },
  'whisper-base': {
    file: 'ggml-base.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`,
    bytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  }
} satisfies Record<string, ModelFile>

export type ModelId = keyof typeof MODELS

/** A build by its id, as installed.json names it. */
export const engineById = (id: string): EngineBuild | null => (Object.hasOwn(ENGINES, id) ? ENGINES[id] : null)

/**
 * The whisper.cpp build for a system (`gpu`: an NVIDIA GPU was found), or none where whisper.cpp has no build. Linux's
 * runs on the CPU; macOS's on Metal.
 */
export function engineFor(platform: NodeJS.Platform, arch: string, gpu: boolean): EngineBuild | null {
  if (platform === 'win32') return arch === 'arm64' ? ENGINES['win-arm64'] : gpu ? ENGINES['win-cuda'] : ENGINES['win-cpu']
  if (platform === 'linux') return arch === 'arm64' ? ENGINES['linux-arm64'] : arch === 'x64' ? ENGINES['linux-x64'] : null
  if (platform === 'darwin') return ENGINES.mac
  return null
}

/**
 * The Whisper model for a build: large-v3-turbo on a GPU, base on a CPU, where turbo's every utterance takes seconds.
 * Parakeet is in both.
 */
export const whisperFor = (engine: EngineBuild): ModelId => (engine.gpu ? 'whisper-turbo' : 'whisper-base')
