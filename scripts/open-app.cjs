const path = require('node:path')
const fs = require('node:fs')
const { spawn, execFileSync } = require('node:child_process')
const T = require('./build-tools.cjs')

try {
  const directory = path.join(T.ROOT, 'dist')
  const portable = process.platform === 'win32' ? path.join(directory, 'win-unpacked/Togle.exe')
    : process.platform === 'darwin' ? path.join(directory, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Togle.app/Contents/MacOS/Togle')
      : path.join(directory, process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'togle')
  const installed = process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Togle/Togle.exe') : undefined
  let app, manifest, failure
  for (const candidate of [installed, portable].filter(Boolean)) {
    if (!fs.existsSync(candidate)) continue
    try {
      const resources = process.platform === 'darwin' ? path.resolve(candidate, '../../Resources') : path.join(path.dirname(candidate), 'resources')
      manifest = T.verifyPackage(resources); app = candidate; break
    } catch (error) { failure = error }
  }
  if (!app) throw failure || new Error('No current Togle build is installed. Run the Togle installer, or npm run pack for a portable development build.')
  const other = T.runningApps().find(item => path.relative(path.resolve(item.file), path.resolve(app)))
  if (other) throw new Error('An older Togle is running from ' + other.file + '. Quit it from the tray before opening this build.')
  if (process.argv.includes('--shortcut')) {
    if (process.platform !== 'win32') throw new Error('--shortcut currently updates the Windows Start Menu entry.')
    const command = "$linkPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Togle.lnk'; $linkShell = New-Object -ComObject WScript.Shell; $link = $linkShell.CreateShortcut($linkPath); if ($link.TargetPath -and [IO.Path]::GetFileName($link.TargetPath) -ne 'Togle.exe') { throw 'The existing shortcut belongs to another application.' }; $link.TargetPath = $env:TOGLE_SHORTCUT_TARGET; $link.WorkingDirectory = [IO.Path]::GetDirectoryName($env:TOGLE_SHORTCUT_TARGET); $link.Arguments = ''; $link.IconLocation = $env:TOGLE_SHORTCUT_TARGET + ',0'; $link.Description = $env:TOGLE_SHORTCUT_DESCRIPTION; $link.Save()"
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env: { ...process.env, TOGLE_SHORTCUT_TARGET: app, TOGLE_SHORTCUT_DESCRIPTION: 'Togle build ' + manifest.id } })
    console.log('Updated the Togle Start Menu shortcut.')
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(app, [], { cwd: path.dirname(app), env, detached: true, windowsHide: true, stdio: 'ignore' })
  child.once('error', error => { console.error(error.message); process.exitCode = 1 })
  child.once('spawn', () => { child.unref(); console.log('Opened Togle ' + manifest.id + ' from ' + app) })
} catch (error) { console.error(error.message); process.exitCode = 1 }
