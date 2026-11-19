# Togle icon

The source is [icon.svg](icon.svg): a rounded white T and mint listening dot on an indigo tile. The broad shapes remain readable at taskbar sizes. The surrounding margin is transparent.

The artwork is authored as vector code and rasterized locally with Electron. Two image-service generation attempts failed with network errors, so the delivered artwork uses this reproducible local workflow.

Run `npm run icons` after editing the source. It creates:

- `icon.png`: 1024 pixels, used by Linux packaging and as a runtime asset.
- `icon-32.png`: a small preview.
- `icon.ico`: Windows sizes from 16 through 256 pixels, with alpha.

The renderer and favicon use the SVG. Native windows use the packaged PNG or ICO. Windows executable and installer resources use the ICO; macOS packaging converts the 1024-pixel PNG to ICNS.

For an unsigned Windows development build, keep resource editing enabled:

```sh
npm run pack -- --config.win.signExecutable=false
node test/verify-package-icon.cjs dist/win-unpacked/Togle.exe
```

`signAndEditExecutable=false` also disables icon embedding. The verification command checks the primary executable icon against the source at every size and checks the runtime assets.

## The name and icon Windows shows

Notifications and the taskbar take Togle's name and icon from the Start menu shortcut that carries Togle's id, `io.togle.app` (the builder's `appId`). If they show Electron's, another shortcut carries the id too, and Windows picked it. Check:

```powershell
Get-StartApps | Where-Object AppID -eq io.togle.app
```

It lists one entry, named Togle. Togle run from the source (`app.isPackaged` is false) uses `io.togle.app.source` so it can't take the id (`src/main/app-id.ts`, tested in `test/app-id.test.mjs`). A taskbar button that is already open keeps its old icon until Togle restarts.
