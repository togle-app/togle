// The parts of Electron's main-process API that the modules under test use. The bundle gets this in place of
// 'electron' (see rolldown.config.mjs). The objects live on a global, so the bundle and a test file share
// them: a test can swap in its own net.fetch or utilityProcess.fork.
const fake = (globalThis.__togleTestElectron ??= {
  app: {
    isPackaged: false,
    getPath: () => process.env.TOGLE_TEST_USER_DATA,
    getVersion: () => '0.0.0-test',
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`ENC:${text}`, 'utf8'),
    decryptString: (buf) => Buffer.from(buf).toString('utf8').slice(4)
  },
  net: { fetch: () => Promise.reject(new Error('net.fetch is not set up for this test')) },
  shell: { openExternal: async () => {} },
  utilityProcess: {
    fork: () => {
      throw new Error('utilityProcess.fork is not set up for this test')
    }
  },
  nativeImage: {},
  protocol: {},
  screen: {},
  desktopCapturer: {},
  BrowserWindow: class {}
})

export const { app, safeStorage, net, shell, utilityProcess, nativeImage, protocol, screen, desktopCapturer, BrowserWindow, MessageChannelMain } = fake
export default fake
