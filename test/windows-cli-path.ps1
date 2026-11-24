$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '..\build\windows-cli-path.ps1'
$root = [Microsoft.Win32.Registry]::CurrentUser
$prefix = 'Software\Togle.CliPath.Test.' + [Guid]::NewGuid().ToString('N')
$environmentKey = $prefix + '\Environment'
$ownershipKey = $prefix + '\Owned'
$environment = $root.CreateSubKey($environmentKey)
$first = 'C:\Apps\Togle\resources\bin'
$second = 'C:\Test Programs\Togle\resources\bin'
$raw = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames

function Check-Path($expected) {
    $actual = $environment.GetValue('Path', $null, $raw)
    if (![object]::Equals($actual, $expected)) { throw 'Unexpected user PATH after an installer operation.' }
}
function Update-Path($action, $directory) { & $helper $action $directory $environmentKey $ownershipKey }

try {
    Update-Path Add $first
    Check-Path $first
    Update-Path Add $first
    Check-Path $first
    Update-Path Remove $first
    Check-Path $null

    # Exercise a PATH longer than NSIS or CMD string buffers, with expansion, quotes and empty entries.
    $original = (('C:\Unrelated\Directory;' * 450) + ';"C:\A;B";%SystemRoot%\System32;')
    $environment.SetValue('Path', $original, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    Update-Path Add $first
    Check-Path ($original + ';' + $first)
    Update-Path Add $second
    Check-Path ($original + ';' + $second)
    Update-Path Remove $first
    Check-Path ($original + ';' + $second)
    $environment.SetValue('Path', $original + ';' + $second + ';C:\AddedAfterSetup', 'ExpandString')
    Update-Path Remove $second
    Check-Path ($original + ';C:\AddedAfterSetup')
    if ($environment.GetValueKind('Path') -ne 'ExpandString') { throw 'PATH type changed' }

    # An equivalent user-supplied entry must survive both install and uninstall.
    $env:TOGLE_PATH_FIXTURE = 'C:\Apps'
    $existing = 'C:\Keep;"%TOGLE_PATH_FIXTURE%\TOGLE\resources\bin\"'
    $environment.SetValue('Path', $existing, 'ExpandString')
    Update-Path Add $first
    Update-Path Remove $first
    Check-Path $existing

    $existing = '%TOGLE_PATH_FIXTURE%\literal'
    $unusual = 'C:\Apps;Team\Togle\resources\bin'
    $environment.SetValue('Path', $existing, 'String')
    Update-Path Add $unusual
    Update-Path Add $unusual
    Check-Path ($existing + ';"' + $unusual + '"')
    Update-Path Remove $unusual
    Check-Path $existing
    if ($environment.GetValueKind('Path') -ne 'String') { throw 'A literal user PATH was converted to an expandable value' }
} finally {
    $environment.Dispose()
    $root.DeleteSubKeyTree($prefix, $false)
}
