# Installs Togle on Windows for the person who runs it, with no administrator rights: a release from GitHub,
# checked against Togle's release key before it runs. The key is written in when the script is published; it is the
# same key every update is checked with.
#   Stable: powershell -NoProfile -Command "iex (irm https://togle.app/stable/install.ps1 -ErrorAction Stop)"
#   Beta:   powershell -NoProfile -Command "iex (irm https://togle.app/beta/install.ps1 -ErrorAction Stop)"
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $Modulus = 'jrG3LNas8oqsyscSaTyo+lpkYkk8DId4RwTZ47fcFs8Cv9FeJKUxhG0+FWjX3Ajn9aYs2SNo8gh5J5M4OmdZNRK3Qk4ua93IvUIzWm70Uq7BD7JGP/fgQrdK4WHBsymwW9ClNJBHbv44H0RWURBoJthGjHNYRn6s4tdTbTrWPjWcXBx1XBe7HvjJqsoihWGdS+00ORCXmKf6VO6uTwIRI2lz4m/1vBEa7xEb7rqF4tmOUM/G3oNMpWyOZdRWuecwfMiNcgPGDmmlGmWX8BsXKfMC6VFEjyC0pky0ViCRdeucT6fQQg7C0UbSuVpWj5mDk/zS0y+Q39NkUk/EmvtfnBu6iMOtLTZravT6jgTnLNIgUJsWo0Owbyav7Ewu2yd7u0BVFl0glN/bI9RcV5dC6xwL5IURkxyv1LlfHpyfiAtIL0C+z9OYaQMtERwSv1JDX//uHY0ypFRGlONATmOk0mF7SUEMwElcTw8uIIyS6p75ofyU+teCqkaR1Dr0+YyT'
  $Exponent = 'AQAB'
  $ChannelUrl = 'https://api.github.com/repos/togle-app/togle/releases/latest'
  $Stable = $ChannelUrl.EndsWith('/releases/latest')
  $Releases = if ($env:TOGLE_INSTALL_RELEASES) { $env:TOGLE_INSTALL_RELEASES } else { $ChannelUrl }
  $NoStable = 'No stable Windows release of Togle Free is available yet. For the Windows beta, use https://togle.app/beta/install.ps1.'
  $Headers = @{ 'User-Agent' = 'togle-install' }

  if ($Modulus.StartsWith('__')) { throw 'This install script has no release key written in. Get install.ps1 from a published Togle Free release.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # RSA-3072, SHA-256, PKCS #1 v1.5: the signature release-key.mjs makes.
  function Test-Signature([byte[]]$Data, [byte[]]$Signature) {
    $parameters = New-Object System.Security.Cryptography.RSAParameters
    $parameters.Modulus = [Convert]::FromBase64String($Modulus)
    $parameters.Exponent = [Convert]::FromBase64String($Exponent)
    $rsa = New-Object System.Security.Cryptography.RSACng
    try {
      $rsa.ImportParameters($parameters)
      return $rsa.VerifyData($Data, $Signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    } finally { $rsa.Dispose() }
  }

  # A fresh curl invocation resumes the bytes already written after a broken connection.
  function Save-ReleaseAsset($Asset, [string]$Destination, [switch]$Resume) {
    $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
    $expected = [long]$Asset.size
    for ($attempt = 1; $attempt -le 4; $attempt++) {
      try {
        if ([IO.File]::Exists($curl)) {
          $range = @()
          if ($Resume -and [IO.File]::Exists($Destination)) { $range = @('--continue-at', '-') }
          & $curl -q --fail --location --silent --connect-timeout 20 --speed-limit 1 --speed-time 90 --user-agent togle-install @range --output $Destination -- $Asset.browser_download_url
          $code = $LASTEXITCODE
          if ($code -ne 0) {
            # A server can decline a range. Request the whole file on the next attempt.
            if ($range.Count -and $code -in 22, 33, 36) { [IO.File]::Delete($Destination) }
            throw "curl exited with code $code."
          }
        } else {
          Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Destination -Headers $Headers -UseBasicParsing
        }
        $length = (Get-Item -LiteralPath $Destination).Length
        if ($length -eq 0 -or ($expected -gt 0 -and $length -ne $expected)) {
          if ($expected -gt 0 -and $length -gt $expected) { [IO.File]::Delete($Destination) }
          throw "Received $length bytes. Expected $expected."
        }
        return
      } catch {
        if ($attempt -eq 4) { throw "Could not download $($Asset.name) after four attempts. $($_.Exception.Message)" }
        Write-Host "Retrying the download of $($Asset.name)..."
        Start-Sleep -Seconds $attempt
      }
    }
  }

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try { $release = Invoke-RestMethod -Uri $Releases -Headers $Headers; break }
    catch {
      if ($_.Exception.Response.StatusCode -eq 404) {
        if ($Stable) { throw $NoStable }
        throw
      }
      if ($attempt -eq 3) { throw }
      Start-Sleep -Seconds $attempt
    }
  }
  if ($release.draft) { throw 'This release is a draft.' }
  if ($Stable -and $release.prerelease) { throw $NoStable }
  $installer = $release.assets | Where-Object { $_.name -match 'Setup.*\.exe$' } | Select-Object -First 1
  if (-not $installer) { throw "Togle $($release.tag_name) has no Windows installer." }
  $signature = $release.assets | Where-Object { $_.name -eq ($installer.name + '.sig') } | Select-Object -First 1
  if (-not $signature) { throw "Togle $($release.tag_name) has no signature for its installer, so nothing was installed." }

  $folder = Join-Path ([IO.Path]::GetTempPath()) ('togle-install-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $folder | Out-Null
  $file = Join-Path $folder 'TogleSetup.exe'
  $signatureFile = $file + '.sig'
  try {
    Write-Host "Downloading Togle $($release.tag_name)..."
    Save-ReleaseAsset $installer $file -Resume
    Save-ReleaseAsset $signature $signatureFile
    if (-not (Test-Signature ([IO.File]::ReadAllBytes($file)) ([IO.File]::ReadAllBytes($signatureFile)))) {
      throw 'The download does not match Togle''s release key, so nothing was installed.'
    }
    Write-Host 'Signature checked.'
    if ($env:TOGLE_INSTALL_DRY_RUN -eq '1') { Write-Host "Checked, not installed: $($installer.name)"; return }
    $process = Start-Process -FilePath $file -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "The installer stopped with code $($process.ExitCode)." }
    Write-Host 'Togle is installed. Open it from the Start menu, then hold F9 and talk.'
  } finally {
    Remove-Item -LiteralPath $file, $signatureFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $folder -ErrorAction SilentlyContinue
  }
}
