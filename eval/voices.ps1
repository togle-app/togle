# Speaks the end-to-end test's sales call into eval/audio as 16 kHz mono WAV files: the caller's questions
# (Zira) and my replies (David), with the voices that come with Windows. Run by e2e.cjs when they're missing.
Add-Type -AssemblyName System.Speech
$dir = Join-Path $PSScriptRoot 'audio'
New-Item -ItemType Directory -Force $dir | Out-Null
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)

function Say([string]$voice, [string]$text, [string]$name) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voice)
  $synth.SetOutputToWaveFile((Join-Path $dir "$name.wav"), $format)
  $synth.Speak($text)
  $synth.Dispose()
}

$them = 'Microsoft Zira Desktop'
$me = 'Microsoft David Desktop'
Say $them "Thanks for the demo, it looks really good. We'd be about forty users. What would the Growth plan cost us per month?" 'q1'
Say $me "For forty users on Growth, that's fifteen hundred and sixty euros a month." 'r1'
Say $them "Okay. And is single sign-on included in that plan?" 'q2'
Say $me "Single sign-on is part of our Enterprise plan." 'r2'
Say $them "Our security team will ask this first. Where would our data be stored?" 'q3'
Say $me "Everything is hosted in Frankfurt, in the EU." 'r3'
Say $them "Good. Can we try it before we buy?" 'q4'
Say $me "Yes, there's a free trial." 'r4'
Say $them "One more thing. Does it work with SAP?" 'q5'
Say $me "It does, through a partner connector." 'r5'
