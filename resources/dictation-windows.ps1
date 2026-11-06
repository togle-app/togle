$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public static class TogleTextInput {
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union data; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  public static string WindowClass(IntPtr hwnd) { var text=new StringBuilder(256); GetClassName(hwnd,text,256); return text.ToString(); }
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, int message, ref int start, ref int end);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  public static bool ModifiersDown() { foreach(int key in new int[]{16,17,18,91,92}) if((GetAsyncKeyState(key) & 0x8000)!=0) return true; return false; }
  public static int[] Selection(int hwnd) { int start=0,end=0; SendMessage(new IntPtr(hwnd),0x00B0,ref start,ref end); return new int[]{start,end}; }
  public static uint Write(string text) {
    Input[] input=new Input[text.Length*2];
    for(int i=0;i<text.Length;i++) {
      input[i*2].type=1; input[i*2].data.keyboard.scan=text[i]; input[i*2].data.keyboard.flags=4;
      input[i*2+1].type=1; input[i*2+1].data.keyboard.scan=text[i]; input[i*2+1].data.keyboard.flags=6;
    }
    return SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(Input)));
  }
  public static uint Paste() {
    Input[] input=new Input[4];
    for(int i=0;i<input.Length;i++) { input[i].type=1; input[i].data.keyboard.vk=(ushort)(i==0 || i==3 ? 0x11 : 0x56); input[i].data.keyboard.flags=(uint)(i>=2 ? 2 : 0); }
    return SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(Input)));
  }
  // Eagerly copy every advertised format: retaining the old IDataObject would
  // leave a lazy reference to the clipboard that this lease is about to replace.
  public sealed class ClipboardText : IDisposable {
    readonly IDataObject previous;
    readonly string marker=Guid.NewGuid().ToString();
    readonly uint captured;
    uint published;
    const string MarkerFormat="Togle.Dictation.ClipboardLease";
    public ClipboardText() {
      captured=GetClipboardSequenceNumber();
      var original=Clipboard.GetDataObject();
      if(original!=null) {
        var saved=new DataObject();
        foreach(string format in original.GetFormats(false)) {
          object value=original.GetData(format,false);
          if(value==null) throw new InvalidOperationException("The clipboard could not be preserved.");
          var stream=value as MemoryStream;
          if(stream!=null) value=new MemoryStream(stream.ToArray());
          else if(value is ICloneable) value=((ICloneable)value).Clone();
          saved.SetData(format,false,value);
        }
        previous=saved;
      }
      if(captured!=GetClipboardSequenceNumber()) throw new InvalidOperationException("The clipboard changed. Try dictation again.");
    }
    public void Publish(string text) {
      if(captured!=GetClipboardSequenceNumber()) throw new InvalidOperationException("The clipboard changed. Try dictation again.");
      var data=new DataObject();
      data.SetText(text,TextDataFormat.UnicodeText);
      data.SetData(MarkerFormat,false,marker);
      // Temporary dictation text should not become a clipboard-history entry.
      data.SetData("CanIncludeInClipboardHistory",false,new MemoryStream(new byte[4]));
      data.SetData("CanUploadToCloudClipboard",false,new MemoryStream(new byte[4]));
      try { Clipboard.SetDataObject(data,true,5,20); }
      finally { published=GetClipboardSequenceNumber(); }
    }
    public void Dispose() {
      // A user copy during insertion owns the clipboard; never replace it.
      if(published==0 || GetClipboardSequenceNumber()!=published) return;
      var current=Clipboard.GetDataObject();
      if(current==null || !String.Equals(current.GetData(MarkerFormat,false) as string,marker) || GetClipboardSequenceNumber()!=published) return;
      if(previous==null) Clipboard.Clear();
      else Clipboard.SetDataObject(previous,true,5,20);
    }
  }
}
'@ | Out-Null

function Read-FocusedText {
  $front = [TogleTextInput]::GetForegroundWindow().ToInt64().ToString()
  if ($front -eq '0') { throw 'Choose a text box on your desktop first.' }
  $frontHandle = [TogleTextInput]::GetForegroundWindow()
  $frontClass = [TogleTextInput]::WindowClass($frontHandle)
  $terminal = $frontClass -match '^(ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS)$'
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $element -and $terminal) {
    [uint32]$processId = 0
    [void][TogleTextInput]::GetWindowThreadProcessId($frontHandle, [ref]$processId)
    return @{ front=$front; identity="terminal:$front"; kind='keys'; terminal=$true; label=(Get-Process -Id $processId).ProcessName }
  }
  if ($null -eq $element -or $element.Current.IsPassword -or !$element.Current.IsEnabled) { throw 'Choose an editable, non-password text box.' }
  $label = (Get-Process -Id $element.Current.ProcessId -ErrorAction Stop).ProcessName
  $keys = @{ front=$front; identity=($element.GetRuntimeId() -join ','); kind='keys'; label=$label }
  $terminal = $terminal -or ($label -match '^(WindowsTerminal|OpenConsole|conhost|cmd|powershell|pwsh|wezterm-gui|mintty|alacritty)$') -or ($element.Current.ClassName -match '(?i)xterm|terminal')
  if ($terminal) { $keys.terminal=$true; return $keys }
  $edit = $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit
  $document = $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document
  $value = $null
  $hasValue = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)
  if ($hasValue -and $value.Current.IsReadOnly) { throw 'This text box is read-only.' }
  $writableValue = $hasValue -and !$value.Current.IsReadOnly
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
    $readOnly = $pattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
    if ($readOnly -is [bool] -and $readOnly) { throw 'This text box is read-only.' }
    # Search/chat inputs can expose ComboBox or Custom instead of Edit. Their
    # writable patterns identify the text field; the visual role alone does not.
    if (!$edit -and !$document -and !$writableValue -and !($readOnly -is [bool] -and !$readOnly -and $element.Current.HasKeyboardFocus)) {
      throw 'Focus an editable text field before dictating.'
    }
    # Rich editors can accept keyboard input while not exposing a reliable editable value or cursor.
    if ($document) {
      if (($writableValue -or ($readOnly -is [bool] -and !$readOnly)) -and $element.Current.HasKeyboardFocus) { return $keys }
      throw 'Focus an editable text field before dictating.'
    }
    $selection = $pattern.GetSelection()
    if ($selection.Count -ne 1) { return $keys }
    # Chromium may expose an empty editor's accessible label through DocumentRange.
    # ValuePattern reports its actual editable value, including an empty string.
    $all = if ($hasValue) { $value.Current.Value } else { $pattern.DocumentRange.GetText(200001) }
    $prefix = $pattern.DocumentRange.Clone()
    $prefix.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $selection[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    $start = $prefix.GetText(200001).Length
    $length = $selection[0].GetText(200001).Length
    # A bounded range immediately behind the caret confirms input even when a
    # virtualized editor changes the rest of its accessible document on redraw.
    $beforeCaret = $selection[0].Clone()
    $beforeCaret.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $selection[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    [void]$beforeCaret.MoveEndpointByUnit([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, [System.Windows.Automation.Text.TextUnit]::Character, -16400)
    $keys.beforeCaret = $beforeCaret.GetText(16400)
    $keys.start=$start; $keys.length=$length
  } elseif ($hasValue -and $element.Current.NativeWindowHandle -ne 0 -and $element.Current.ClassName -match '(?i)edit') {
    $all = $value.Current.Value
    $range = [TogleTextInput]::Selection($element.Current.NativeWindowHandle)
    $start = $range[0]; $length = $range[1] - $range[0]
  } elseif (($edit -or $writableValue) -and $element.Current.HasKeyboardFocus) { return $keys }
  else { throw 'Focus an editable text field before dictating.' }
  if ($all.Length -gt 200000 -or $start -lt 0 -or $length -lt 0 -or $start+$length -gt $all.Length) { return $keys }
  if ([TogleTextInput]::GetForegroundWindow().ToInt64().ToString() -ne $front) { throw 'The focused app changed. Your text will be ready to copy.' }
  return @{ front=$front; identity=($element.GetRuntimeId() -join ','); kind='text'; content=$all; start=$start; length=$length; beforeCaret=$keys.beforeCaret; label=$label }
}

function Test-SameTarget($target, $current) {
  if ($current.front -ne $target.front -or $current.identity -ne $target.identity -or $current.kind -ne $target.kind) { return $false }
  if ($target.kind -eq 'text' -and ($current.content -cne $target.content -or $current.start -ne $target.start -or $current.length -ne $target.length)) { return $false }
  if ($target.kind -eq 'keys' -and $target.ContainsKey('beforeCaret') -and ($current.beforeCaret -cne $target.beforeCaret -or $current.start -ne $target.start -or $current.length -ne $target.length)) { return $false }
  return $true
}

$targets = @{}
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'capture') {
      $targets.Clear()
      try {
        $target = Read-FocusedText
        $token = [guid]::NewGuid().ToString()
        $targets[$token] = $target
        $result = @{ token=$token; label=$target.label; windowHandle=$target.front }
      } catch { $result = @{ label='Your text box'; reason=$_.Exception.Message } }
    } elseif ($request.command -eq 'insert') {
      $token = [string]$request.token; $text = [string]$request.text
      $target = $targets[$token]; $targets.Remove($token)
      if (!$target -or $text.Length -eq 0 -or $text.Length -gt 16000) { throw 'This dictation is no longer ready to insert.' }
      # Line breaks and tabs travel as text in a paste, never as shortcut/Enter keys.
      if ($text -match '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]') { throw 'This text contains unsupported control characters.' }
      if ($target.terminal -and $text -match '[\x00-\x1f\x7f]') { throw 'Line breaks cannot be entered automatically into a terminal.' }
      # A shortcut can still be held while recognition finishes. Never type with Ctrl/Alt/Win down.
      for ($attempt=0; $attempt -lt 40 -and [TogleTextInput]::ModifiersDown(); $attempt++) { Start-Sleep -Milliseconds 20 }
      if ([TogleTextInput]::ModifiersDown()) { throw 'Release the shortcut keys. Your text is ready to copy.' }
      $current = Read-FocusedText
      if (!(Test-SameTarget $target $current)) {
        $result = @{ inserted=$false; message='The text box or cursor changed. Copy your text where you need it.' }
      } elseif ($target.terminal) {
        if ([TogleTextInput]::GetForegroundWindow().ToInt64().ToString() -ne $target.front) { throw 'The focused app changed. Your text is ready to copy.' }
        $count = [TogleTextInput]::Write($text)
        # Keyboard delivery only, never Enter, clipboard paste, or an automatic retry in a terminal.
        $result = @{ inserted=($count -eq $text.Length*2); message='Text sent to the focused app. Check the result before retrying.' }
      } else {
        $expected = if ($target.kind -eq 'text') { $target.content.Substring(0,$target.start) + $text + $target.content.Substring($target.start+$target.length) } else { $null }
        $clipboard = $null
        $inserted = $false
        try {
          try { $clipboard = New-Object 'TogleTextInput+ClipboardText' }
          catch {
            # An unsupported clipboard format must not break ordinary dictation.
            # Construction has not changed the clipboard; Unicode delivery is safe.
            if ($text -match '[\x00-\x1f\x7f]') { throw }
          }
          if ($null -ne $clipboard) { $clipboard.Publish($text) }
          # Clipboard ownership/setup must not permit a late focus or cursor change.
          $beforePaste = Read-FocusedText
          if (!(Test-SameTarget $target $beforePaste)) { throw 'The text box or cursor changed.' }
          if ([TogleTextInput]::ModifiersDown()) { throw 'Release the shortcut keys.' }
          $delivered = if ($null -ne $clipboard) { [TogleTextInput]::Paste() -eq 4 } else { [TogleTextInput]::Write($text) -eq $text.Length*2 }
          $inserted = $false
          if ($delivered -and $target.kind -eq 'keys') {
            # Some document controls expose no readable value; let the target
            # consume its paste before restoring the original clipboard.
            Start-Sleep -Milliseconds 250
            $inserted=$true
          } elseif ($delivered) {
            for ($attempt=0; $attempt -lt 8; $attempt++) {
            Start-Sleep -Milliseconds 30
            try {
              $after = Read-FocusedText
              if ($after.front -ne $target.front -or $after.identity -ne $target.identity) { break }
              # Empty contenteditable editors (CodeMirror, Markdown and rich text)
              # can expose their placeholder <br> as a newline. Typing removes it.
              # Confirm the actual text and caret instead of expecting the phantom
              # newline to remain. Never retry input after an uncertain result.
              $placeholderRemoved = $target.content -match '\A(?:\r\n|\n|\r)\z' -and $target.start -eq 0 -and $target.length -eq 0 -and $after.content -ceq $text -and $after.start -eq $text.Length -and $after.length -eq 0
              $normalized = $after.content -replace '\r\n?',"`n"
              $normalizedExpected = $expected -replace '\r\n?',"`n"
              # Accessibility serializes empty rich-editor paragraphs differently
              # from their clipboard text. Verify their visible text in that case.
              $paragraphsMatch = ($normalized -replace '\n{2,}',"`n") -ceq ($normalizedExpected -replace '\n{2,}',"`n")
              $context = (($after.beforeCaret -replace '\r\n?',"`n") -replace '\n{2,}',"`n").TrimEnd([char[]]"`n")
              $typed = (($text -replace '\r\n?',"`n") -replace '\n{2,}',"`n").Trim([char[]]"`n")
              $caretAdvanced = $after.start -ne $target.start -or $after.length -ne $target.length -or $after.beforeCaret -cne $target.beforeCaret
              $contextMatches = $typed.Length -gt 0 -and $context.EndsWith($typed,[StringComparison]::Ordinal) -and $caretAdvanced
              if ($after.content -ceq $expected -or $paragraphsMatch -or $placeholderRemoved -or $contextMatches) { $inserted=$true; break }
            } catch { break }
            }
          }
          $result = if ($inserted) { @{ inserted=$true } } else { @{ inserted=$false; message='Could not confirm insertion. Check your text box before copying to avoid duplicate text.' } }
        } finally {
          if ($null -ne $clipboard) {
            try { $clipboard.Dispose() }
            catch { if ($inserted) { $result = @{ inserted=$true; message='Text entered. The clipboard could not be restored.' } } }
          }
        }
      }
    } else { throw 'Unknown dictation operation.' }
    [Console]::WriteLine((@{ id=$request.id; result=$result } | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::WriteLine((@{ id=$request.id; error=$_.Exception.Message } | ConvertTo-Json -Compress -Depth 3))
  }
}
