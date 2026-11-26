import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Device, Task } from './device-client';
import { AgentMark, agentName, Icon } from './icons';
import {
  AccountLimits,
  UsageReadings,
  usePhoneReport,
  type LoadReport,
} from './ReportUsage';
import { StatusPill } from './Session';
import { useTheme } from './ui';

type Filter = 'all' | 'waiting' | 'working';
type Props = {
  devices: Device[];
  active: boolean;
  loadReport: LoadReport;
  notice?: React.ReactNode;
  onOpen(device: Device, task: Task): void;
};

export function Agents({ devices, active, loadReport, notice, onOpen }: Props) {
  const { s, colors } = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [usageOpen, setUsageOpen] = useState(false);
  const usage = devices
    .map(device => ({
      device,
      providers: [...new Set(device.tasks.map(task => agentName(task.agent)))],
    }))
    .filter(group => group.providers.length);
  const count = usage.reduce(
    (total, group) => total + group.providers.length,
    0,
  );
  const counts = { all: 0, waiting: 0, working: 0 };
  for (const host of devices) {
    for (const task of host.tasks) {
      counts.all++;
      if (task.state === 'waiting' || task.state === 'working')
        counts[task.state]++;
    }
  }
  const ordered = [...devices].sort(
    (a, b) =>
      Number(b.tasks.length > 0) - Number(a.tasks.length > 0) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
  );

  const toggle = (key: string) =>
    setFolded(value => ({ ...value, [key]: !value[key] }));
  return (
    <>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={s.h1}>
          Agents
        </Text>
        {!!devices.length && (
          <Text style={s.secondary}>
            {count} {count === 1 ? 'agent' : 'agents'} · {devices.length}{' '}
            {devices.length === 1 ? 'device' : 'devices'}
          </Text>
        )}
      </View>
      {notice}
      {!!count && (
        <View style={s.panel}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agent usage"
            accessibilityState={{ expanded: usageOpen }}
            onPress={() => setUsageOpen(open => !open)}
            style={styles.usageHeading}
          >
            <Icon name="usage" color={colors.muted} />
            <Text style={[s.h2, s.grow]}>Agent usage</Text>
            <Icon
              name={usageOpen ? 'down' : 'right'}
              color={colors.muted}
              size={16}
            />
          </Pressable>
          {usageOpen &&
            usage.map(({ device, providers }) => (
              <DeviceUsage
                key={device.device}
                device={device}
                providers={providers}
                active={active}
                loadReport={loadReport}
                folded={folded}
                toggle={toggle}
              />
            ))}
        </View>
      )}
      {(counts.all > 0 || filter !== 'all') && (
        <View style={s.actions}>
          {(
            [
              ['all', 'All agents'],
              ['waiting', 'Waiting ' + counts.waiting],
              ['working', 'Working ' + counts.working],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: filter === value }}
              onPress={() => setFilter(value)}
              style={[
                styles.filter,
                filter === value
                  ? { backgroundColor: colors.tint, borderColor: colors.accent }
                  : {
                      backgroundColor: colors.surface,
                      borderColor: colors.line,
                    },
              ]}
            >
              <Text
                style={[
                  s.label,
                  { color: filter === value ? colors.accent : colors.muted },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {ordered.map(device => {
        const tasks =
          filter === 'all'
            ? device.tasks
            : device.tasks.filter(task => task.state === filter);
        if (filter !== 'all' && !tasks.length) return null;
        return (
          <DeviceCard
            key={device.device}
            device={device}
            tasks={tasks}
            folded={folded}
            toggle={toggle}
            onOpen={task => onOpen(device, task)}
          />
        );
      })}
      {filter !== 'all' && counts[filter] === 0 && (
        <Text style={s.secondary}>No {filter} sessions right now.</Text>
      )}
    </>
  );
}

function DeviceUsage({
  device,
  providers,
  active,
  loadReport,
  folded,
  toggle,
}: {
  device: Device;
  providers: string[];
  active: boolean;
  loadReport: LoadReport;
  folded: Record<string, boolean>;
  toggle(key: string): void;
}) {
  const { s, colors } = useTheme();
  const report = usePhoneReport(device, active, loadReport);
  const agents = report?.kind === 'usage' ? report.agents : [];
  return (
    <View style={[s.divider, styles.usageGroup]}>
      <Text style={s.label}>{device.name}</Text>
      {providers.map(name => {
        const entry = agents.find(agent => agentName(agent.name) === name);
        const limits = entry?.usage.limits;
        const key = JSON.stringify([
          'limits',
          device.device,
          entry?.runner ?? name,
        ]);
        const open = !!folded[key];
        return (
          <View key={name} style={styles.usageAgent}>
            <AgentMark agent={name} />
            <View style={[s.grow, styles.usageDetails]}>
              <Text style={s.label}>{name}</Text>
              <UsageReadings readings={entry?.usage.readings} />
              {!!limits?.length && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${name} account limits on ${device.name}`}
                    accessibilityState={{ expanded: open }}
                    onPress={() => toggle(key)}
                    style={styles.limits}
                  >
                    <Text style={[s.label, { color: colors.accent }]}>
                      Account limits
                    </Text>
                    <Icon
                      name={open ? 'down' : 'right'}
                      color={colors.accent}
                      size={15}
                    />
                  </Pressable>
                  {open && <AccountLimits limits={limits} />}
                </>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function DeviceCard({
  device,
  tasks,
  folded,
  toggle,
  onOpen,
}: {
  device: Device;
  tasks: Task[];
  folded: Record<string, boolean>;
  toggle(key: string): void;
  onOpen(task: Task): void;
}) {
  const { s, colors } = useTheme();
  const deviceKey = JSON.stringify([device.device]);
  const expanded = !folded[deviceKey];
  const groups = new Map<string, Task[]>();
  const prioritized = [...tasks].sort(
    (a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'),
  );
  for (const item of prioritized) {
    const folder = groups.get(item.folder);
    if (folder) folder.push(item);
    else groups.set(item.folder, [item]);
  }
  return (
    <View style={s.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => toggle(deviceKey)}
        style={styles.row}
      >
        <View
          style={[
            styles.deviceIcon,
            { backgroundColor: device.online ? colors.tint : colors.raised },
          ]}
        >
          <Icon
            name={device.role === 'server' ? 'server' : 'laptop'}
            color={device.online ? colors.accent : colors.muted}
            size={22}
          />
        </View>
        <View style={s.grow}>
          <Text style={s.h2}>{device.name}</Text>
          <View style={s.topRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: device.online ? colors.good : colors.muted },
              ]}
            />
            <Text style={s.secondary}>
              {device.online ? 'Online' : 'Offline'} ·{' '}
              {device.role === 'server' ? 'Server' : 'Computer'}
            </Text>
          </View>
        </View>
        <Icon
          name={expanded ? 'down' : 'right'}
          color={colors.muted}
          size={17}
        />
      </Pressable>
      {expanded &&
        (tasks.length ? (
          [...groups].map(([folder, items]) => {
            const key = JSON.stringify([device.device, folder]);
            return (
              <React.Fragment key={key}>
                {!!folder && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !folded[key] }}
                    style={[styles.folder, s.divider]}
                    onPress={() => toggle(key)}
                  >
                    <Icon
                      name={folded[key] ? 'right' : 'down'}
                      color={colors.muted}
                      size={16}
                    />
                    <Text style={[s.label, { color: colors.muted }]}>
                      {folder}
                    </Text>
                  </Pressable>
                )}
                {!folded[key] &&
                  items.map(item => (
                    <Pressable
                      key={item.key}
                      accessibilityRole="button"
                      onPress={() => onOpen(item)}
                      style={({ pressed }) => [
                        styles.row,
                        s.divider,
                        pressed && { backgroundColor: colors.raised },
                      ]}
                    >
                      <AgentMark agent={item.agent} />
                      <View style={s.grow}>
                        <Text style={s.h2}>{item.title}</Text>
                        <Text style={s.secondary}>{agentName(item.agent)}</Text>
                      </View>
                      <StatusPill state={item.state} />
                      <Icon name="right" color={colors.muted} size={15} />
                    </Pressable>
                  ))}
              </React.Fragment>
            );
          })
        ) : (
          <Text style={[s.secondary, s.divider, styles.empty]}>
            {device.online
              ? 'No sessions shared right now.'
              : 'Shared sessions appear when this device is online.'}
          </Text>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 4 },
  filter: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 23,
    paddingHorizontal: 14,
  },
  row: {
    minHeight: 65,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  usageHeading: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  usageGroup: { padding: 14, gap: 11 },
  usageAgent: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  usageDetails: { gap: 4 },
  limits: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  empty: { padding: 15 },
  deviceIcon: {
    width: 40,
    height: 40,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  folder: {
    minHeight: 47,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
