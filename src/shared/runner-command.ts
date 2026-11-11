// Whether a command an agent wants to run looks dangerous, and why, in plain words. It is a hint for the person
// reading the request and never what lets a command run: the whole command is shown, and that is what runs. A command
// it cannot read (text fetched or hidden, then run) counts as dangerous too.

// Each rule: what to look for in the command (one line, spaces folded), and what to say of it.
const RULES: readonly [RegExp, string][] = [
  // Deleting
  [/\brm\s+(?:-[a-z]*[rf][a-z]*|--recursive|--force)\b/i, 'It deletes files or folders for good.'],
  [/\b(?:Remove-Item|ri|del|erase|rd|rmdir)\b[^|;&]*?(?:-Recurse|-Force|\s\/[sq]\b)/i, 'It deletes files or folders for good.'],
  [/\b(?:shred|mkfs(?:\.\w+)?|diskpart|format\s+[a-z]:)\b/i, 'It wipes a disk or a file with no way back.'],
  [/\bdd\s[^|;&]*\bof=/i, 'It writes straight over a disk or a file.'],
  // Git history and pushing over what is there
  [/\bgit\s+(?:-\S+\s+)*push\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b|\s--delete\b|\s:\S)/i, 'It pushes over what is on the server, or deletes it there.'],
  [/\bgit\s+(?:-\S+\s+)*reset\s+--hard\b/i, 'It throws away changes that are not saved.'],
  [/\bgit\s+(?:-\S+\s+)*clean\s+-[a-z]*f/i, 'It deletes files Git does not track.'],
  [/\bgit\s+(?:-\S+\s+)*(?:checkout\s+--\s|restore\s+(?:--source\S*\s+)?\.)/i, 'It throws away changes that are not saved.'],
  [/\bgit\s+(?:-\S+\s+)*(?:branch\s+-D\b|filter-branch\b)/i, 'It deletes a branch or rewrites history.'],
  // Text that is fetched or hidden, then run
  [/\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python3?|node)\b/i, 'It runs text it downloads, so what it does cannot be read here.'],
  [/\b(?:iex|Invoke-Expression)\b/i, 'It runs text as a command, so what it does cannot be read here.'],
  [/(?:^|\s)-(?:enc|encodedcommand|ec)\s/i, 'It runs hidden text as a command, so what it does cannot be read here.'],
  [/FromBase64String|\bbase64\s+(?:-d|--decode)\b[^|;&]*\|\s*(?:sh|bash|zsh|iex)\b/i, 'It runs hidden text as a command, so what it does cannot be read here.'],
  [/(?:^|[\s;&|(])eval\s/, 'It runs text as a command, so what it does cannot be read here.'],
  // The computer itself
  [/(?:^|[\s;&|(])(?:sudo|runas|doas)\s/i, 'It runs with more rights than the task has.'],
  [/\b(?:chmod\s+(?:-R\b|[0-7]?777\b)|chown\b|icacls\b|takeown\b)/i, 'It changes who may use files.'],
  [/\b(?:reg\s+(?:add|delete|import)|schtasks|sc(?:\.exe)?\s+(?:delete|config|create|stop)|net\s+(?:user|localgroup)|netsh\b|setx\b|Set-ExecutionPolicy|Set-MpPreference|Disable-\w+)/i, 'It changes accounts, services or settings of the computer.'],
  [/\b(?:Stop-Computer|Restart-Computer|shutdown|reboot|poweroff)\b/i, 'It turns the computer off or restarts it.'],
  [/\b(?:taskkill|Stop-Process|pkill|killall)\b|\bkill\s+-9\b/i, 'It stops programs.'],
  // Servers, containers, clouds, databases
  [/\bterraform\s+(?:apply|destroy|import|state\s+rm)\b/i, 'It changes real servers or cloud resources.'],
  [/\bkubectl\s+(?:delete|apply|replace|drain|rollout|scale|patch)\b|\bhelm\s+(?:install|upgrade|uninstall|delete|rollback)\b/i, 'It changes what runs on a cluster.'],
  [/\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune)|network\s+rm|container\s+prune|image\s+prune)\b/i, 'It deletes containers, images or volumes.'],
  [/\b(?:aws|gcloud|az)\s[^|;&]*\b(?:delete|terminate|remove|destroy)\b/i, 'It deletes cloud resources.'],
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b/i, 'It deletes data in a database.'],
  [/\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, 'It deletes every row of a table.'],
  // Publishing
  [/\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish|deprecate)\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+(?:repo|release)\s+delete\b/i, 'It publishes or deletes something other people use.']
]

/** Why a command looks dangerous, or null when nothing in it does. */
export function dangerOf(command: string): string | null {
  const text = command.replace(/\s+/g, ' ').trim()
  if (!text) return null
  for (const [pattern, reason] of RULES) if (pattern.test(text)) return reason
  return null
}
