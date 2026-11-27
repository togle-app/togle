import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import type { Device, Task } from './device-client';
import { AgentMark, agentName, Icon } from './icons';
import {
  AccountLimits,
  UsageReadings,
  usePhoneReport,
  type LoadReport,
} from './ReportUsage';
import { StatusPill } from './Session';
import { Block, Button, usePageTitle, useTheme } from './ui';

type Filter = 'all' | 'waiting' | 'working';
type Props = {
  devices: Device[];
  active: boolean;
  loadReport: LoadReport;
  notice?: React.ReactNode;
  /** The line under the heading while no computer is listed. */
  hint?: string;
  onOpen(device: Device, task: Task): void;
};

const many = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? '' : 's'}`;

export function Agents({
  devices,
  active,
  loadReport,
  notice,
  hint,
  onOpen,
}: Props) {
  const { s, colors } = useTheme();
  const heading = usePageTitle();
  const { width } = useWindowDimensions();
  // A narrow phone gets tighter rows, a tablet two columns of computers.
  const compact = width <= 390;
  const columns = width >= 800 ? 2 : 1;
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
  const shown = ordered
    .map(device => ({
      device,
      tasks:
        filter === 'all'
          ? device.tasks
          : device.tasks.filter(task => task.state === filter),
    }))
    .filter(entry => filter === 'all' || entry.tasks.length);
  const rows: (typeof shown)[] = [];
  for (let index = 0; index < shown.length; index += columns)
    rows.push(shown.slice(index, index + columns));

  const toggle = (key: string) =>
    setFolded(value => ({ ...value, [key]: !value[key] }));
  const card = ({ device, tasks }: (typeof shown)[number]) => (
    <DeviceCard
      key={device.device}
      device={device}
      tasks={tasks}
      compact={compact}
      folded={folded}
      toggle={toggle}
      onOpen={task => onOpen(device, task)}
    />
  );
  return (
    <>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={heading}>
          Agents
        </Text>
        {devices.length ? (
          <Text style={s.subtitle}>
            {many(count, 'agent') + ' across ' + many(devices.length, 'device')}
          </Text>
        ) : (
          !!hint && <Text style={s.subtitle}>{hint}</Text>
        )}
      </View>
      {notice}
      {!!count && (
        <View style={[s.panel, styles.usage]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agent usage"
            accessibilityState={{ expanded: usageOpen }}
            onPress={() => setUsageOpen(open => !open)}
            style={styles.usageHeading}
          >
            <Icon name="usage" color={colors.muted} size={18} />
            <Text style={[styles.usageTitle, s.strong, s.grow]}>
              Agent usage
            </Text>
            <Icon
              name={usageOpen ? 'down' : 'right'}
              color={colors.muted}
              size={14}
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
        <View style={styles.filters}>
          {(
            [
              ['all', 'All agents'],
              ['waiting', 'Waiting', counts.waiting],
              ['working', 'Working', counts.working],
            ] as const
          ).map(([value, name, amount]) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={
                amount === undefined ? name : `${name} ${amount}`
              }
              accessibilityState={{ selected: filter === value }}
              onPress={() => setFilter(value)}
              style={[
                styles.filter,
                compact && styles.filterCompact,
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
                {name}
                {amount !== undefined && (
                  <Text style={styles.amount}>{' ' + amount}</Text>
                )}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {columns === 1
        ? shown.map(card)
        : rows.map(row => (
            <View key={row[0].device.device} style={styles.columns}>
              {row.map(entry => (
                <View key={entry.device.device} style={s.grow}>
                  {card(entry)}
                </View>
              ))}
              {row.length < columns && <View style={s.grow} />}
            </View>
          ))}
      {filter !== 'all' && counts[filter] === 0 && (
        <Block style={styles.empty}>
          <Text accessibilityRole="header" style={s.h2}>
            {'No agents ' + filter}
          </Text>
          <Button title="Show all agents" onPress={() => setFilter('all')} />
        </Block>
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
      <Text style={[s.label, styles.usageHost, { color: colors.muted }]}>
        {device.name}
      </Text>
      {providers.map((name, index) => {
        const entry = agents.find(agent => agentName(agent.name) === name);
        const limits = entry?.usage.limits;
        const key = JSON.stringify([
          'limits',
          device.device,
          entry?.runner ?? name,
        ]);
        const open = !!folded[key];
        return (
          <View key={name} style={[styles.usageAgent, index > 0 && s.divider]}>
            <AgentMark agent={name} size={25} />
            <View style={s.grow}>
              <View style={styles.usageLine}>
                <Text style={[styles.usageTitle, s.strong]}>{name}</Text>
                <View style={styles.usageValue}>
                  <UsageReadings readings={entry?.usage.readings} end />
                </View>
              </View>
              {!!limits?.length && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${name} account limits on ${device.name}`}
                    accessibilityState={{ expanded: open }}
                    onPress={() => toggle(key)}
                    style={styles.limits}
                  >
                    <Text style={s.small}>Account limits</Text>
                    <Icon
                      name={open ? 'down' : 'right'}
                      color={colors.muted}
                      size={12}
                    />
                  </Pressable>
                  {open && (
                    <View style={styles.limitRows}>
                      <AccountLimits limits={limits} />
                    </View>
                  )}
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
  compact,
  folded,
  toggle,
  onOpen,
}: {
  device: Device;
  tasks: Task[];
  compact: boolean;
  folded: Record<string, boolean>;
  toggle(key: string): void;
  onOpen(task: Task): void;
}) {
  const { s, colors } = useTheme();
  const deviceKey = JSON.stringify([device.device]);
  const expanded = !folded[deviceKey];
  const server = device.role === 'server';
  const [ink, fill] = !device.online
    ? [colors.muted, colors.raised]
    : server
    ? [colors.good, colors.green]
    : [colors.accent, colors.tint];
  // A computer with one folder lists its sessions straight away: a row names its folder.
  const folders = new Set(device.tasks.map(task => task.folder));
  const groups = new Map<string, Task[]>();
  const prioritized = [...tasks].sort(
    (a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'),
  );
  for (const item of prioritized) {
    const name = folders.size > 1 ? item.folder : '';
    const folder = groups.get(name);
    if (folder) folder.push(item);
    else groups.set(name, [item]);
  }
  const side = compact && styles.sideCompact;
  return (
    <View style={s.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => toggle(deviceKey)}
        style={[styles.deviceHead, side]}
      >
        <View style={[styles.deviceIcon, { backgroundColor: fill }]}>
          <Icon name={server ? 'server' : 'laptop'} color={ink} size={19} />
        </View>
        <View style={s.grow}>
          <Text style={s.device}>{device.name}</Text>
          <View style={[s.topRow, styles.deviceMeta]}>
            <View
              style={[
                styles.dot,
                device.online
                  ? { backgroundColor: colors.good }
                  : [styles.dotOff, { borderColor: colors.muted }],
              ]}
            />
            <Text style={s.meta}>
              {device.online ? 'Online' : 'Offline'} ·{' '}
              {server ? 'Server' : 'Computer'}
            </Text>
          </View>
        </View>
        <Icon
          name={expanded ? 'down' : 'right'}
          color={colors.muted}
          size={19}
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
                      size={14}
                    />
                    <Text style={[s.label, { color: colors.muted }]}>
                      {folder}
                    </Text>
                  </Pressable>
                )}
                {!(folder && folded[key]) &&
                  items.map(item => (
                    <Pressable
                      key={item.key}
                      accessibilityRole="button"
                      onPress={() => onOpen(item)}
                      style={({ pressed }) => [
                        styles.row,
                        side,
                        compact && styles.rowCompact,
                        s.divider,
                        pressed && { backgroundColor: colors.raised },
                      ]}
                    >
                      <AgentMark agent={item.agent} size={compact ? 27 : 31} />
                      <View style={s.grow}>
                        <Text style={[s.title, compact && styles.titleCompact]}>
                          {item.title}
                        </Text>
                        <Text style={[s.meta, styles.sub]}>
                          {agentName(item.agent) +
                            (item.folder ? ' · ' + item.folder : '')}
                        </Text>
                      </View>
                      <StatusPill state={item.state} />
                      {!compact && (
                        <Icon name="right" color={colors.muted} size={15} />
                      )}
                    </Pressable>
                  ))}
              </React.Fragment>
            );
          })
        ) : (
          <Text style={[s.secondary, s.divider, styles.none]}>
            {device.online
              ? 'No sessions shared right now.'
              : 'Shared sessions appear when this device is online.'}
          </Text>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 7, marginBottom: 8 },
  usage: { borderRadius: 8 },
  usageHeading: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 13,
  },
  usageTitle: { fontSize: 14 },
  usageGroup: { paddingHorizontal: 13, paddingBottom: 4 },
  usageHost: { paddingTop: 11, paddingBottom: 5 },
  usageAgent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 9,
  },
  usageLine: {
    minHeight: 25,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 9,
    rowGap: 3,
  },
  usageValue: { flexShrink: 1, marginLeft: 'auto' },
  limits: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  limitRows: { paddingBottom: 5 },
  filters: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
    marginBottom: 7,
  },
  filter: {
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 15,
  },
  filterCompact: { paddingHorizontal: 9 },
  amount: { opacity: 0.8 },
  columns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 18,
    marginBottom: 4,
  },
  empty: { alignItems: 'center', paddingVertical: 26, gap: 10 },
  deviceHead: {
    minHeight: 73,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 15,
  },
  deviceIcon: {
    width: 39,
    height: 39,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceMeta: { gap: 6, marginTop: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOff: { borderWidth: 1 },
  folder: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  row: {
    minHeight: 65,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  sideCompact: { paddingHorizontal: 11 },
  rowCompact: { gap: 8 },
  titleCompact: { fontSize: 14 },
  sub: { marginTop: 3 },
  none: { padding: 15 },
});
