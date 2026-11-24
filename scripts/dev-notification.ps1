param([ValidateSet('Show','Remove')] [string] $Action, [ValidatePattern('^[a-f0-9]{16}$')] [string] $Tag)
$ErrorActionPreference = 'Stop'
$appId = 'io.togle.app.source'
$manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
if ($Action -eq 'Remove') { $manager::History.Remove($Tag, 'togle', $appId); return }
$xml = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]::new()
$xml.LoadXml($env:TOGLE_DEV_TOAST_XML)
function Set-DevAction($element, $attribute) {
  $route = [uri]::EscapeDataString($element.GetAttribute($attribute))
  $element.SetAttribute('activationType', 'protocol')
  $element.SetAttribute($attribute, "togle-free-dev://notice/?args=$route")
}
Set-DevAction $xml.DocumentElement 'launch'
foreach ($button in $xml.GetElementsByTagName('action')) { Set-DevAction $button 'arguments' }
$notice = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]::new($xml)
$notice.Tag = $Tag
$notice.Group = 'togle'
$manager::CreateToastNotifier($appId).Show($notice)
