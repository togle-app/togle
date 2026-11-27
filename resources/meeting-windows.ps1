# Read a call's accessible controls. Never activate a window or press a control.
param([switch]$Once, [int]$ProcessId=0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$refs=@([Windows.Automation.AutomationElement].Assembly.Location,[Windows.Automation.ControlType].Assembly.Location,[System.Windows.Rect].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
public static class MeetWindows {
  private static readonly object sync=new object();
  private static readonly AutoResetEvent changed=new AutoResetEvent(false);
  private static AutomationElement mic;
  private static string watched;
  private static int revision;
  private static AutomationPropertyChangedEventHandler handler;
  public static int Revision { get { lock(sync) { return revision; } } }
  // Invalidate on the first mute change, even if the control changes back before the next complete read.
  public static bool Watch(AutomationElement element,string id) {
    if (element!=null && mic!=null && id==watched) {
      try { if (Automation.Compare(mic,element)) return true; } catch (ElementNotAvailableException) {}
    }
    var previous=mic;
    var oldHandler=handler;
    lock(sync) { mic=null; watched=null; handler=null; }
    if (previous!=null) {
      try { Automation.RemoveAutomationPropertyChangedEventHandler(previous,oldHandler); } catch (ElementNotAvailableException) {} catch (InvalidOperationException) {}
    }
    if (element==null) return false;
    AutomationPropertyChangedEventHandler next=delegate(object sender,AutomationPropertyChangedEventArgs args) {
      lock(sync) {
        if (!Object.ReferenceEquals(mic,element)) return;
        revision++;
        Console.WriteLine("{\"id\":\""+id+"\",\"state\":\"gap\"}");
        changed.Set();
      }
    };
    lock(sync) { mic=element; watched=id; handler=next; }
    try {
      Automation.AddAutomationPropertyChangedEventHandler(element,TreeScope.Element,next,AutomationElement.NameProperty,AutomationElement.HelpTextProperty,AutomationElement.IsEnabledProperty,TogglePattern.ToggleStateProperty);
      return true;
    } catch (Exception) {
      lock(sync) { mic=null; watched=null; handler=null; }
      return false;
    }
  }
  public static void Wait(int millis) { changed.WaitOne(millis); }
  private delegate bool Visit(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, Visit visit, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  public static IntPtr WebView(IntPtr window) {
    IntPtr result=IntPtr.Zero;
    EnumChildWindows(window,delegate(IntPtr h,IntPtr unused) {
      var cls=new StringBuilder(80); GetClassName(h,cls,cls.Capacity);
      if (cls.ToString()=="Chrome_RenderWidgetHostHWND" && IsWindowVisible(h)) { result=h; return false; }
      return true;
    },IntPtr.Zero);
    return result;
  }
  public static bool CallCaption(IntPtr h) {
    var text = new StringBuilder(512); GetWindowText(h,text,text.Capacity);
    return System.Text.RegularExpressions.Regex.IsMatch(text.ToString(), @"(?:\b(?:meet(?:ing)?|call|webinar|conference|huddle|besprechung|anruf|videollamada|webex|jitsi|zoom|teams|slack|discord|whereby|ringcentral|whatsapp|signal|goto)\b|[a-z]{3}-[a-z]{4}-[a-z]{3})",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
  }
  public static IntPtr[] Candidates(int[] known) {
    var result = new List<IntPtr>();
    var programs = new HashSet<int>(known);
    EnumWindows(delegate(IntPtr h, IntPtr unused) {
      if (IsWindowVisible(h)) {
        var text = new StringBuilder(512); GetWindowText(h,text,text.Capacity);
        int pid; GetWindowThreadProcessId(h,out pid);
        if (text.Length>0 && (programs.Contains(pid) || CallCaption(h))) result.Add(h);
      }
      return true;
    },IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$ae = [Windows.Automation.AutomationElement]
$ct = [Windows.Automation.ControlType]
$desc = [Windows.Automation.TreeScope]::Descendants
function Is-Type($kind) { [Windows.Automation.PropertyCondition]::new($ae::ControlTypeProperty, $kind) }
function Value-Of($element) {
  if (!$element) { return '' }
  $pattern = $null
  if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return $pattern.Current.Value }
  return ''
}
function Page-Address($window, $document) {
  $value = Value-Of $document
  if ($value -match '^(?:https?://|about:|chrome://|edge://|file://)') { return $value }
  # Only browser chrome, never the page's text fields. Chrome and Edge sometimes omit the URL scheme.
  $conditions = [Windows.Automation.Condition[]]@(
    [Windows.Automation.PropertyCondition]::new($ae::ClassNameProperty, 'Chrome_OmniboxView')
    [Windows.Automation.PropertyCondition]::new($ae::ClassNameProperty, 'OmniboxViewViews')
    [Windows.Automation.PropertyCondition]::new($ae::AutomationIdProperty, 'addressEditBox')
    [Windows.Automation.PropertyCondition]::new($ae::AutomationIdProperty, 'urlbar-input')
  )
  $toolbar = $window.FindFirst($desc, (Is-Type $ct::ToolBar))
  $field = if ($toolbar) { $toolbar.FindFirst($desc, [Windows.Automation.OrCondition]::new($conditions)) }
  if ($field -and !$field.Current.HasKeyboardFocus) {
    $value = Value-Of $field
    if ($value -match '^[\w.-]+\.[\w.-]+(/|$)') { return 'https://' + $value }
    if ($value -match '^(?:https?://|about:|chrome://|edge://|file://)') { return $value }
  }
  return ''
}
function Web-App([uri]$uri) {
  if (!$uri -or !$uri.IsAbsoluteUri -or $uri.UserInfo) { return '' }
  if ($uri.Scheme -ne 'https') {
    if ($uri.Scheme -eq 'http' -and $uri.IsLoopback) { return 'other' }
    return ''
  }
  foreach ($domain in $domains.Keys) {
    if ($uri.Host -eq $domain -or $uri.Host.EndsWith('.'+$domain,[StringComparison]::OrdinalIgnoreCase)) {
      if ($domains[$domain] -eq 'meet' -and $uri.AbsolutePath -notmatch '^/[a-z]{3}-[a-z]{4}-[a-z]{3}/?$') { return '' }
      return $domains[$domain]
    }
  }
  return 'other'
}
function Room-Id([string]$route, $handle) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes("$handle/$route"))
    return [BitConverter]::ToString($bytes,0,16).Replace('-','').ToLowerInvariant()
  } finally { $hash.Dispose() }
}
function Read-Tabs($window) {
  $tree=[Windows.Automation.TreeWalker]::ControlViewWalker
  foreach ($tab in $window.FindAll($desc,(Is-Type $ct::TabItem))) {
    # Read tab identity from the browser chrome.
    $parent=$tree.GetParent($tab)
    while ($parent -and $parent.Current.ControlType -ne $ct::Document -and ![Windows.Automation.Automation]::Compare($parent,$window)) {
      $parent=$tree.GetParent($parent)
    }
    if (!$parent -or $parent.Current.ControlType -eq $ct::Document) { continue }
    $sel = $null
    if ($tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$sel)) {
      [pscustomobject]@{ key=$tab.GetRuntimeId() -join '.'; selected=$sel.Current.IsSelected; name=$tab.Current.Name; selection=$sel }
    }
  }
}
$buttonsOfInterest=[Windows.Automation.OrCondition]::new((Is-Type $ct::Button),(Is-Type $ct::CheckBox))
# Some native controls expose their Win32 button class and handle through a UI Automation pane.
$nativePane=[Windows.Automation.AndCondition]::new((Is-Type $ct::Pane),[Windows.Automation.NotCondition]::new([Windows.Automation.PropertyCondition]::new($ae::NativeWindowHandleProperty,0)))
$nativeControls=[Windows.Automation.OrCondition]::new($buttonsOfInterest,$nativePane)
function Control-Groups($button,$document) {
  $parent=$button
  for ($depth=0; $depth -lt 7; $depth++) {
    $parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
    if (!$parent -or [Windows.Automation.Automation]::Compare($document,$parent)) { break }
    $kind=$parent.Current.ControlType
    if ($kind -eq $ct::Document -or $kind -eq $ct::Window) { break }
    if ($kind -eq $ct::ToolBar -or ($kind -eq $ct::Group -and $parent.Current.Name -match '(call|meeting|huddle|voice|audio).*(control|action)|controls.*(call|meeting)')) {
      $parent.GetRuntimeId() -join '.'
    }
  }
}
function Controls-Of($document, [bool]$native) {
  if (!$document) { return @{ joined=$false; ended=$false; mic='unknown' } }
  $joined=$false; $leaveOnly=$false; $ended=$false; $startMeeting=$false; $joinMeeting=$false; $voiceCall=$false; $videoCall=$false
  $leaves=@(); $own=@(); $neutral=@()
  $cache=[Windows.Automation.CacheRequest]::new()
  foreach ($property in @($ae::NameProperty,$ae::HelpTextProperty,$ae::IsEnabledProperty,$ae::ControlTypeProperty,$ae::ClassNameProperty)) { $cache.Add($property) }
  $condition=if ($native) { $nativeControls } else { $buttonsOfInterest }
  $scope=$cache.Activate()
  try { $buttons=$document.FindAll($desc,$condition) } finally { $scope.Dispose() }
  foreach ($button in $buttons) {
    if ($button.Cached.ControlType -eq $ct::Pane -and $button.Cached.ClassName -notmatch '^(WindowsForms\d+\.BUTTON\.|Button$)') { continue }
    if (!$button.Cached.IsEnabled) { continue }
    $name=([string]$button.Cached.Name).Trim()
    if ($name -match '^(?:(?:Leave|Exit|Disconnect from) (?:the |this )?(?:(?:audio|video|voice) )?(?:call|meeting|huddle|conference|voice channel|room)|End (?:the |this )?(?:(?:audio|video) )?(?:call|meeting)|Hang up|Disconnect from voice|Anruf (?:verlassen|beenden)|Besprechung verlassen|Auflegen|Quitter (?:la |le |l.)?(?:r.union|appel)|Salir de (?:la |la video)?(?:reuni.n|llamada)|Colgar)\b') { $joined=$true; $leaves+=$button; continue }
    if ($name -match '^(?:Leave|Disconnect|Beenden|Verlassen)(?:\s*\([^)]*\))?$') { $leaveOnly=$true; $leaves+=$button; continue }
    if ($name -match '^(?:Rejoin(?: meeting)?|Return to home screen|Join (?:now|meeting|a meeting|huddle|voice channel)|Start (?:a |the )?(?:huddle|voice call|audio call|video call)|Call again|Wieder teilnehmen|Erneut (?:beitreten|teilnehmen)|Zur Startseite|Jetzt teilnehmen)\b') { $ended=$true }
    if ($name -match '^(?:New meeting|Start meeting|Meet now|Neue Besprechung)$') { $startMeeting=$true }
    if ($name -match '^(?:Join|Join voice|Beitreten)$') { $joinMeeting=$true }
    if ($name -match '^(?:Voice call|Audio call)$') { $voiceCall=$true }
    if ($name -eq 'Video call') { $videoCall=$true }
    if ($name -match '^(?:Mic|Microphone|Audio|Mikrofon)$') { $name=([string]$button.Cached.HelpText).Trim() }
    $state=if ($name -match '^(?:Turn off (?:the |your )?(?:microphone|mic)|Turn (?:the |your )?(?:microphone|mic) off|Mute (?:your |my )(?:mic|microphone|audio)|Mute (?:myself|yourself)|Mikrofon (?:ausschalten|deaktivieren|stummschalten)|D.sactiver (?:le |votre )?micro|Silenciar (?:mi |el )?micr.fono)\b') { 'open' }
    elseif ($name -match '^(?:Turn on (?:the |your )?(?:microphone|mic)|Turn (?:the |your )?(?:microphone|mic) on|Unmute (?:your |my )(?:mic|microphone|audio)|Unmute (?:myself|yourself)|Mikrofon (?:einschalten|aktivieren)|Stummschaltung (?:des Mikrofons )?aufheben|Activer (?:le |votre )?micro|Activar (?:mi |el )?micr.fono)\b') { 'muted' }
    if ($state) { $own+=@{state=$state; button=$button}; continue }
    if ($name -match '^(Mute|Unmute|Stummschalten)(?: (?:microphone|mic|audio))?(?:\s*[,(:\[].*)?$') {
      $item=@{state=if ($Matches[1] -eq 'Unmute') { 'muted' } else { 'open' }; button=$button}
      if ($name -match '(?:Ctrl|Control|Alt)\s*\+\s*(?:Shift\s*\+\s*)?[DMA]\b') { $own+=$item } else { $neutral+=$item }
    }
  }
  # A participant menu can also contain "Mute". A bare action must share the call toolbar with Leave.
  if (!$own.Count -and $neutral.Count -and $leaves.Count) {
    $groups=@(foreach ($leave in $leaves) { Control-Groups $leave $document })
    $own=@(foreach ($item in $neutral) {
      if (@(Control-Groups $item.button $document | Where-Object { $_ -in $groups }).Count) { $item }
    })
  }
  $toggle=if ($own.Count -eq 1) { $own[0].button }
  $mic=if ($toggle) { $own[0].state } else { 'unknown' }
  return @{ joined=($joined -or ($leaveOnly -and !!$toggle)); ended=($ended -or ($startMeeting -and $joinMeeting) -or ($voiceCall -and $videoCall)); mic=$mic; toggle=$toggle }
}
function Report($id,$state) { [Console]::WriteLine((@{id=$id; app=$tracked.app; state=$state} | ConvertTo-Json -Compress)) }
function Active-MicrophonePrograms {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged'
  foreach ($program in (Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue)) {
    if ($program.GetValue('LastUsedTimeStart',0) -gt 0 -and $program.GetValue('LastUsedTimeStop',-1) -eq 0) {
      [IO.Path]::GetFileNameWithoutExtension($program.PSChildName.Replace('#','\'))
    }
  }
}
$programs=@{}; $domains=@{}
foreach ($entry in ([Console]::ReadLine() | ConvertFrom-Json)) {
  foreach ($program in $entry.programs) { $programs[$program]=$entry.id }
  foreach ($domain in $entry.hosts) { $domains[$domain]=$entry.id }
}
$browsers=@('chrome','msedge','brave','firefox','vivaldi','opera','chromium')
$lastPrograms=[datetime]::MinValue
$tracked=$null
$missing=0
do {
  try {
    if (!$tracked -and ([datetime]::UtcNow-$lastPrograms).TotalSeconds -gt 6) {
      $inUse=@(Active-MicrophonePrograms)
      $nativePids=[int[]]@(Get-Process | Where-Object { $programs.ContainsKey($_.ProcessName) -or $_.ProcessName -in $browsers -or $_.ProcessName -in $inUse } | Select-Object -ExpandProperty Id)
      $lastPrograms=[datetime]::UtcNow
    }
    $candidates=if ($tracked) { @($tracked.window) } else { @([MeetWindows]::Candidates($nativePids)) }
    $reported=$false
    foreach ($handle in $candidates) {
      try {
        if (!$handle) { continue }
        if (![MeetWindows]::IsWindow($handle)) {
          if ($tracked) { Report $tracked.id 'left'; $tracked=$null; $reported=$true }
          continue
        }
        [int]$ownerId=0
        [void][MeetWindows]::GetWindowThreadProcessId($handle,[ref]$ownerId)
        if ($ProcessId -and $ProcessId -ne $ownerId) { continue }
        $program=(Get-Process -Id $ownerId -ErrorAction SilentlyContinue).ProcessName
        if (!$program -or $program -in @('Togle','Togle Studio','electron','powershell','pwsh','explorer','WindowsTerminal','cmd','conhost','ApplicationFrameHost')) { continue }
        $browser=$program -in $browsers
        $window=$ae::FromHandle($handle)
        $document=if ($browser) { $window.FindFirst($desc,(Is-Type $ct::Document)) } else { $window }
        if ($browser -and !$document) {
          $view=[MeetWindows]::WebView($handle)
          if ($view -ne [IntPtr]::Zero) {
            $content=$ae::FromHandle($view)
            $document=if ($content.Current.ControlType -eq $ct::Document) { $content } else { $content.FindFirst($desc,(Is-Type $ct::Document)) }
          }
        }
        $address=if ($browser) { Page-Address $window $document } else { '' }
        $appId=if ($browser) { if ($address) { Web-App ([uri]$address) } } elseif ($programs.ContainsKey($program)) { $programs[$program] } else { 'other' }
        $room=if ($appId) {
          $route=if ($browser) { ([uri]$address).GetLeftPart([UriPartial]::Path) } else { "$ownerId/$program" }
          Room-Id $route $handle
        } else { '' }
        $selected=$null
        if ($browser -and $tracked.selection) {
          try { $selected=$tracked.selection.Current.IsSelected } catch { }
        }
        # A Slack channel or Teams chat can change the URL inside an ongoing call on the same tab.
        $samePageApp=$browser -and $selected -eq $true -and $appId -in @('teams','slack','discord','whatsapp','webex','ringcentral','other') -and $tracked.authority -eq ([uri]$address).Authority
        if ($samePageApp) { $room=$tracked.id }
        if ($room -and $selected -ne $false -and (!$tracked -or $room -eq $tracked.id)) {
          $revision=[MeetWindows]::Revision
          $controls=Controls-Of $document (!$browser)
          if ($controls.joined -and ($tracked -or $appId -ne 'other' -or $controls.toggle)) {
            if (!$tracked) {
              $tab=if ($browser) { Read-Tabs $window | Where-Object selected | Select-Object -First 1 }
              $tracked=@{window=$handle; id=$room; app=$appId; tab=if ($tab) {$tab.key} else {''}; title=if ($tab) {$tab.name} else {''}; selection=$tab.selection; authority=if ($browser) { ([uri]$address).Authority }}
            }
            $watching=[MeetWindows]::Watch($controls.toggle,$room)
            $mic=if ($watching -and $revision -eq [MeetWindows]::Revision) { $controls.mic } else { 'unknown' }
            $missing=0; Report $room $mic; $reported=$true; break
          }
          if ($tracked -and $controls.ended) { Report $tracked.id 'left'; $tracked=$null; $reported=$true; break }
        }
        if ($tracked) {
          # Browser tab identity can confirm closure even when the replacement page has no address.
          $gone=$false
          if ($browser -and $tracked.tab) {
            $tabs=@(Read-Tabs $window)
            $old=@($tabs | Where-Object key -eq $tracked.tab)
            $navigated=$old -and $old[0].selected -and $address -and $room -ne $tracked.id
            $closed=!$old -and @($tabs | Where-Object selected).Count -eq 1 -and !@($tabs | Where-Object name -eq $tracked.title).Count
            $gone=$navigated -or $closed
          }
          if ($gone) { $missing++ } else { $missing=0 }
          if ($missing -ge 2) { Report $tracked.id 'left'; $tracked=$null }
          else { Report $tracked.id 'unknown' }
          $reported=$true; break
        }
      } catch { if ($tracked) { $missing=0; Report $tracked.id 'unknown'; $reported=$true; break } }
    }
    if (!$reported) { if ($tracked) { $missing=0; Report $tracked.id 'unknown' } else { [Console]::WriteLine('.') } }
  } catch { if ($tracked) { $missing=0; Report $tracked.id 'unknown' } else { [Console]::WriteLine('.') } }
  if (!$tracked) { [void][MeetWindows]::Watch($null,'') }
  if (!$Once) { if ($tracked) { [MeetWindows]::Wait(350) } else { Start-Sleep -Milliseconds 1800 } }
} while (!$Once)
