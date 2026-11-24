param([string] $Action, [string] $Id, [string] $Clsid, [string] $Argument)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($Id -notmatch '^io\.togle\.noticecheck\.[a-f0-9]{12}$' -or $Clsid -notmatch '^\{[a-f0-9-]{36}\}$') { throw 'Expected the disposable notification identity' }
$manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
$settings = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$Id"
switch ($Action) {
  'prepare' {
    New-Item -Path $settings -Force | Out-Null
    $banner = [int]($Argument -eq 'live-banner')
    New-ItemProperty -Path $settings -Name ShowBanner -Value $banner -PropertyType DWord -Force | Out-Null
  }
  'history' {
    $items = @($manager::History.GetHistory($Id) | ForEach-Object {
      [pscustomobject]@{
        tag=$_.Tag
        xml=$_.Content.GetXml()
        text=@($_.Content.GetElementsByTagName('text') | ForEach-Object { $_.InnerText })
        launch=$_.Content.DocumentElement.GetAttribute('launch')
        actions=@($_.Content.GetElementsByTagName('action') | ForEach-Object { $_.GetAttribute('arguments') })
      }
    })
    ConvertTo-Json -InputObject $items -Compress
  }
  'activate' {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("53e31837-6600-4a81-9395-75cffe746f94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotificationActivationCallback {
  void Activate([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string args, IntPtr inputs, uint count);
}
public static class ToastCheck {
  public static void Open(string clsid, string appId, string args) {
    object server = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid), true));
    try { ((INotificationActivationCallback)server).Activate(appId, args, IntPtr.Zero, 0); }
    finally { Marshal.ReleaseComObject(server); }
  }
}
'@
    [ToastCheck]::Open($Clsid, $Id, $Argument)
  }
  'button' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [Windows.Automation.AutomationElement]::RootElement
    $scope = [Windows.Automation.TreeScope]
    $nameProperty = [Windows.Automation.AutomationElement]::NameProperty
    $button = [Windows.Automation.PropertyCondition]::new($nameProperty, 'Start notes')
    $ownName = 'Togle Notification Test ' + ($Id -split '\.')[-1]
    $label = [Windows.Automation.PropertyCondition]::new($nameProperty, $ownName)
    $shellIds = @(Get-Process ShellExperienceHost, ShellHost -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    for ($try = 0; $try -lt 32; $try++) {
      foreach ($window in $root.FindAll($scope::Children, [Windows.Automation.Condition]::TrueCondition)) {
        try {
          if ($window.Current.ProcessId -notin $shellIds) { continue }
          $matches = $window.FindAll($scope::Descendants, $button)
          if ($matches.Count -ne 1) { continue }
          $item = $matches.Item(0)
          $parent = $item
          for ($depth = 0; $depth -lt 12 -and $null -ne $parent; $depth++) {
            if ($parent.Current.ProcessId -notin $shellIds) { break }
            if ($parent.Current.Name.Contains($ownName) -or $parent.FindFirst($scope::Descendants, $label)) {
              $item.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
              Write-Output 'invoked'
              return
            }
            if ($parent.Equals($window)) { break }
            $parent = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
          }
        } catch [Windows.Automation.ElementNotAvailableException] {}
      }
      Start-Sleep -Milliseconds 200
    }
    Write-Output 'no visible test banner'
  }
  'cleanup' {
    $manager::History.Clear($Id)
    if (Test-Path -LiteralPath $settings) { Remove-Item -LiteralPath $settings -Force }
    $server = "HKCU:\Software\Classes\CLSID\$Clsid"
    if (Test-Path -LiteralPath "$server\LocalServer32") { Remove-Item -LiteralPath "$server\LocalServer32" -Force }
    if (Test-Path -LiteralPath $server) { Remove-Item -LiteralPath $server -Force }
  }
}
