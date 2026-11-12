// Hermes on this computer, through ACP (acp.ts): `hermes acp` speaks JSON-RPC over its standard input and output.
// Hermes asks about a command only when its own settings say to (the person's may be set to never ask), and refuses some
// commands outright without asking.
import { AcpBackend, exists, lines } from './acp'

export interface HermesOptions {
  /** What starts Hermes, before the word `acp`. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** Togle's version, told to Hermes. */
  version?: string
  /** A model for every task ("provider:model"), when the person's default is not the one to use. */
  model?: string
}

/** The program that starts Hermes, or null when it is not on this computer. `TOGLE_HERMES_PATH` names it by hand. */
export async function findHermes(): Promise<string | null> {
  const forced = process.env.TOGLE_HERMES_PATH
  if (forced && (await exists(forced))) return forced
  const found = await lines(process.platform === 'win32' ? 'where' : 'which', ['hermes'])
  if (process.platform !== 'win32') return found[0] ?? null
  // The .cmd beside it is a shim that Node cannot start without a shell.
  return found.find((file) => /\.exe$/i.test(file)) ?? null
}

export class HermesBackend extends AcpBackend {
  constructor(options: HermesOptions = {}) {
    // What starts it, without the word `acp`: the version is asked of that.
    const program = async (): Promise<string[] | null> => (options.command?.length ? options.command : [await findHermes()].filter((found): found is string => !!found))
    super({
      runner: 'hermes',
      name: 'Hermes',
      command: async () => {
        const base = await program()
        return base?.length ? [...base, 'acp'] : null
      },
      versionOf: async () => {
        const base = await program()
        return base?.length ? (await lines(base[0], [...base.slice(1), '--version']))[0] : undefined
      },
      ...(options.env ? { env: options.env } : {}),
      ...(options.version ? { version: options.version } : {}),
      ...(options.model ? { model: options.model } : {})
    })
  }
}
