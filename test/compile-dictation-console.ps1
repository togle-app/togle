param([string]$Source, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -Path $Source -OutputAssembly $Destination -OutputType WindowsApplication
