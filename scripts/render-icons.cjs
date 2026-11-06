// Rasterize the vector master, then build native sizes. No fonts, network service or image dependencies.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const build = path.join(root, 'build')
const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8')
const data = path.join(root, 'test', '.work', 'icons-' + process.pid)
fs.mkdirSync(data, { recursive: true })
app.setPath('userData', data)
app.on('window-all-closed', () => {})
const timeout = setTimeout(() => { console.error('Icon rendering timed out'); app.exit(1) }, 20000)

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', width: 1024, height: 1024,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true }
  })
  const html = '<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}svg{width:100%;height:100%;display:block}</style>' + svg
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const master = await window.webContents.capturePage()
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024]
  const images = new Map()
  for (const size of sizes) {
    const image = master.resize({ width: size, height: size, quality: 'best' })
    const dimensions = image.getSize()
    if (dimensions.width !== size || dimensions.height !== size) throw new Error('Wrong icon dimensions at ' + size)
    images.set(size, image.toPNG())
  }
  fs.writeFileSync(path.join(build, 'icon.png'), images.get(1024))
  fs.writeFileSync(path.join(build, 'icon-32.png'), images.get(32))
  // ICO entries contain their original PNG data, retaining alpha and high-DPI sizes.
  const entries = sizes.filter(size => size <= 256)
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  for (const [i, size] of entries.entries()) {
    const at = 6 + i * 16
    const png = images.get(size)
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  }
  fs.writeFileSync(path.join(build, 'icon.ico'), Buffer.concat([header, ...entries.map(size => images.get(size))]))
  console.log('Created icon.png, icon-32.png and icon.ico from build/icon.svg.')
  window.destroy()
  clearTimeout(timeout)
  app.quit()
}).catch(error => { console.error(error.stack); app.exit(1) })
