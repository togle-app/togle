param(
    [Parameter(Mandatory)] [ValidateSet('Add', 'Remove')] [string]$Action,
    [Parameter(Mandatory)] [string]$BinDirectory,
    [Parameter(Mandatory)] [string]$EnvironmentKey,
    [Parameter(Mandatory)] [string]$OwnershipKey
)
$ErrorActionPreference = 'Stop'
$hive = [Microsoft.Win32.Registry]::CurrentUser
$directory = [IO.Path]::GetFullPath($BinDirectory).TrimEnd('\')
$targetEntry = if ($directory.Contains(';')) { '"' + $directory + '"' } else { $directory }
$owners = $hive.OpenSubKey($OwnershipKey, $true)
$environment = $null
try {
    $owned = @(if ($owners) { $owners.GetValueNames() })
    if ($Action -eq 'Remove') {
        $retire = @($owned | Where-Object { $_ -ieq $targetEntry })
        if (!$retire.Count) { return }
    } else {
        # Retire earlier locations when an upgrade moves the installation.
        $retire = @($owned | Where-Object { $_ -ine $targetEntry })
    }

    $environment = $hive.CreateSubKey($EnvironmentKey)
    $raw = $environment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($null -eq $raw) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $environment.GetValueKind('Path') }
    if ($kind -notin @('String', 'ExpandString')) { throw 'The user PATH is not a string.' }

    $entries = [Collections.Generic.List[string]]::new()
    if ($raw) {
        # Keep empty entries and quoted paths containing semicolons intact.
        $entries.AddRange([regex]::Split($raw, ';(?=(?:[^"]*"[^"]*")*[^"]*$)'))
    }
    foreach ($entry in $retire) {
        $index = $entries.LastIndexOf($entry)
        if ($index -ge 0) { $entries.RemoveAt($index) }
    }
    $addEntry = $Action -eq 'Add'
    if ($addEntry) {
        foreach ($entry in $entries) {
            $value = $entry.Trim().Trim('"')
            if ($kind -eq 'ExpandString') { $value = [Environment]::ExpandEnvironmentVariables($value) }
            if ($value.Replace('/', '\').TrimEnd('\') -ieq $directory) { $addEntry = $false; break }
        }
        if ($addEntry) { $entries.Add($targetEntry) }
    }
    $updated = $entries -join ';'
    if ($addEntry -and $updated.Length -gt 32766) { throw 'Adding Togle would exceed the Windows environment-variable length limit.' }
    if ($addEntry) {
        if (!$owners) { $owners = $hive.CreateSubKey($OwnershipKey) }
        # Record ownership first so an interrupted install can complete or clean up on retry.
        $owners.SetValue($targetEntry, 1, [Microsoft.Win32.RegistryValueKind]::DWord)
    }
    if ($updated -cne [string]$raw) {
        if ($entries.Count) { $environment.SetValue('Path', $updated, $kind) }
        else { $environment.DeleteValue('Path', $false) }
    }
    foreach ($entry in $retire) { $owners.DeleteValue($entry, $false) }
} finally {
    if ($environment) { $environment.Dispose() }
    if ($owners) { $owners.Dispose() }
}
