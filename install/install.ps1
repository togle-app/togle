# Installs Togle on Windows for the person who runs it, with no administrator rights: the latest release from GitHub,
# checked against Togle's release key before it runs. The key is written in when the script is published; it is the
# same key every update is checked with.
#   irm https://togle.app/install.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $Modulus = '__TOGLE_RELEASE_MODULUS__'
  $Exponent = '__TOGLE_RELEASE_EXPONENT__'
  $Releases = if ($env:TOGLE_INSTALL_RELEASES) { $env:TOGLE_INSTALL_RELEASES } else { 'https://api.github.com/repos/togle-app/togle/releases/latest' }
  $Headers = @{ 'User-Agent' = 'togle-install' }

  if ($Modulus.StartsWith('__')) { throw 'This install script has no release key written in. Get it from https://togle.app/install.ps1' }
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

  $release = Invoke-RestMethod -Uri $Releases -Headers $Headers
  $installer = $release.assets | Where-Object { $_.name -match 'Setup.*\.exe$' } | Select-Object -First 1
  if (-not $installer) { throw "Togle $($release.tag_name) has no Windows installer." }
  $signature = $release.assets | Where-Object { $_.name -eq ($installer.name + '.sig') } | Select-Object -First 1
  if (-not $signature) { throw "Togle $($release.tag_name) has no signature for its installer, so nothing was installed." }

  $folder = Join-Path ([IO.Path]::GetTempPath()) ('togle-install-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $folder | Out-Null
  try {
    $file = Join-Path $folder $installer.name
    Write-Host "Downloading Togle $($release.tag_name)..."
    Invoke-WebRequest -Uri $installer.browser_download_url -OutFile $file -Headers $Headers -UseBasicParsing
    Invoke-WebRequest -Uri $signature.browser_download_url -OutFile ($file + '.sig') -Headers $Headers -UseBasicParsing
    if (-not (Test-Signature ([IO.File]::ReadAllBytes($file)) ([IO.File]::ReadAllBytes($file + '.sig')))) {
      throw 'The download does not match Togle''s release key, so nothing was installed.'
    }
    Write-Host 'Signature checked.'
    if ($env:TOGLE_INSTALL_DRY_RUN -eq '1') { Write-Host "Checked, not installed: $($installer.name)"; return }
    $process = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "The installer stopped with code $($process.ExitCode)." }
    Write-Host 'Togle is installed. Open it from the Start menu, then hold F9 and talk.'
  } finally {
    Remove-Item -Recurse -Force $folder -ErrorAction SilentlyContinue
  }
}
