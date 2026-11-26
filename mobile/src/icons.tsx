import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { PhoneReceipt } from './phone-report';
import { useTheme } from './ui';

const icons = {
  todo: require('../assets/icons/todo.png'),
  agents: require('../assets/icons/agents.png'),
  laptop: require('../assets/icons/laptop.png'),
  server: require('../assets/icons/server.png'),
  left: require('../assets/icons/left.png'),
  right: require('../assets/icons/right.png'),
  down: require('../assets/icons/down.png'),
  more: require('../assets/icons/more.png'),
  check: require('../assets/icons/check.png'),
  doubleCheck: require('../assets/icons/check-double.png'),
  usage: require('../assets/icons/usage.png'),
  clock: require('../assets/icons/clock.png'),
};

const agents = {
  codex: { name: 'Codex', image: require('../assets/icons/codex.png') },
  claudecode: {
    name: 'Claude Code',
    image: require('../assets/icons/claude.png'),
  },
  githubcopilot: {
    name: 'GitHub Copilot',
    image: require('../assets/icons/github-copilot.png'),
  },
  hermes: { name: 'Hermes', image: require('../assets/icons/hermes.png') },
  cline: { name: 'Cline', image: require('../assets/icons/cline.png') },
};

function agentKey(agent: string) {
  const id = agent.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id === 'claude') return 'claudecode';
  if (id === 'copilot' || id === 'githubcopilotcli') return 'githubcopilot';
  if (id === 'hermesagent') return 'hermes';
  return id;
}

function provider(agent: string) {
  const id = agentKey(agent);
  return Object.hasOwn(agents, id)
    ? agents[id as keyof typeof agents]
    : undefined;
}

export function agentName(agent: string) {
  return provider(agent)?.name ?? agent;
}

export function Icon({
  name,
  color,
  size = 20,
}: {
  name: keyof typeof icons;
  color: string;
  size?: number;
}) {
  return (
    <Image
      source={icons[name]}
      accessible={false}
      style={{ width: size, height: size, tintColor: color }}
    />
  );
}

const deliveryMarks = {
  sending: { icon: 'clock', label: 'Sending' },
  sent: { icon: 'check', label: 'Sent to server' },
  delivered: { icon: 'doubleCheck', label: 'Delivered to agent' },
} as const;

export function DeliveryTicks({ state }: { state: PhoneReceipt | 'sending' }) {
  const { colors } = useTheme();
  const { icon, label } = deliveryMarks[state];
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
    >
      <Icon
        name={icon}
        color={state === 'delivered' ? colors.accent : colors.muted}
        size={16}
      />
    </View>
  );
}

export function AgentMark({
  agent,
  size = 32,
}: {
  agent: string;
  size?: number;
}) {
  const { colors, s } = useTheme();
  const mark = provider(agent);
  return (
    <View
      style={[
        styles.mark,
        { width: size, height: size, backgroundColor: colors.raised },
      ]}
    >
      {mark ? (
        <Image
          source={mark.image}
          accessible={false}
          style={{
            width: size * 0.64,
            height: size * 0.64,
            tintColor: colors.ink,
          }}
        />
      ) : (
        <Text style={s.label}>{agent.trim().charAt(0).toUpperCase()}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
});
