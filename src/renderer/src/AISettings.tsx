import { useState } from 'react'
import type { ApiConnection, Settings } from '@shared/types'
import type { SettingsPatch } from '@shared/api'
import { AccountSettings } from './Accounts'
import { ConnectionEditor, ConnectionRows, useConnections } from './Connections'
import { ModelSettings } from './ModelSettings'
import { Section } from './Rows'

export function AISettings({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<unknown> }) {
  const connections = useConnections()
  const [editing, setEditing] = useState<{ kind: ApiConnection['kind']; connection?: ApiConnection }>()
  return <>
    <Section id="settings-ai" title="Accounts" note="Connect subscriptions, API keys and local models here. Adding a connection keeps your current defaults.">
      <AccountSettings settings={settings} addApi={kind => setEditing({ kind })}
        connections={<ConnectionRows connections={connections.connections} settings={settings} edit={connection => setEditing({ kind: connection.kind, connection })} />} />
      {editing && <ConnectionEditor key={editing.connection?.id || editing.kind} {...editing} close={() => setEditing(undefined)} />}
    </Section>
    <ModelSettings settings={settings} save={save} />
  </>
}
