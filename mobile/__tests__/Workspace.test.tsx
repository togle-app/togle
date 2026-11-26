import React from 'react';
import { Text, TextInput } from 'react-native';
import Renderer from 'react-test-renderer';
import { DataScanner } from 'react-native-data-scanner';
import { Workspace } from '../src/Workspace';
import { createPhoneClient, type PhoneState } from '../src/device-client';

jest.mock('../src/account', () => ({
  deviceStore: () => ({ read: async () => null, write: async () => {} }),
  tokenFor: async () => 'test-token',
}));
jest.mock('../src/config.generated', () => ({
  config: { relay: 'ws://test.invalid/v1' },
}));
jest.mock('../src/device-client', () => ({ createPhoneClient: jest.fn() }));
jest.mock('react-native-data-scanner', () => ({
  DataScanner: { scanBarcode: jest.fn() },
}));

const state: PhoneState = {
  standing: 'member',
  link: 'member',
  connection: 'on',
  devices: [
    {
      device: 'host',
      name: 'Work laptop',
      role: 'computer',
      online: true,
      canAct: true,
      tasks: [
        {
          key: 'session',
          agent: 'Codex',
          title: 'Review a release',
          folder: 'website',
          state: 'waiting',
          line: '',
          mine: true,
          pending: [
            {
              id: 'question',
              kind: 'question',
              question: 'Which release?',
              choices: ['Beta', 'Stable'],
            },
          ],
        },
      ],
    },
  ],
};

test('opens a To-do reply in Agents and keeps the list filter and usage fold', async () => {
  const answer = jest.fn().mockResolvedValue(undefined);
  jest.mocked(createPhoneClient).mockImplementation(({ onChange }) => {
    onChange(state);
    return {
      ready: Promise.resolve(),
      pair: jest.fn(),
      joinInvitation: jest.fn(),
      cancelPair: jest.fn(),
      answer,
      chat: jest.fn(),
      readReport: jest.fn(),
      close: jest.fn(),
    };
  });
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(
      <Workspace userId="account" email="test@example.test" plan="pro" />,
    );
  });
  const button = (label: string) => {
    const all = tree.root.findAll(
      node => typeof node.props.onPress === 'function',
    );
    return (
      all.find(node => node.props.accessibilityLabel === label) ??
      all.find(node =>
        node.findAllByType(Text).some(child => child.props.children === label),
      )
    );
  };
  const press = (label: string) =>
    Renderer.act(async () => {
      const target = button(label);
      expect(target).toBeDefined();
      await target?.props.onPress();
    });

  expect(createPhoneClient).toHaveBeenCalled();
  expect(button('Agent usage')?.props.accessibilityState.expanded).toBe(false);
  await press('Agent usage');
  await press('Waiting 1');
  await press('To-do');
  await press('Reply to Review a release');
  expect(button('Agents')?.props.accessibilityState.selected).toBe(true);
  expect(button('Back to Agents')).toBeDefined();

  await press('To-do');
  await press('Agents');
  await press('Stable');
  expect(answer).toHaveBeenCalledWith('host', 'session', 'question', 1);
  await press('Back to Agents');
  expect(button('Agent usage')?.props.accessibilityState.expanded).toBe(true);
  expect(button('Waiting 1')?.props.accessibilityState.selected).toBe(true);
  await press('To-do');
  expect(button('Reply to Review a release')).toBeUndefined();
  await Renderer.act(() => tree.unmount());
});

test('refreshes an open usage group each minute and hides it when reporting is revoked', async () => {
  jest.useFakeTimers();
  const host = { ...state.devices[0], phoneReports: true };
  const readReport = jest.fn().mockResolvedValue({
    kind: 'usage',
    agents: [
      {
        runner: 'codex',
        name: 'Codex',
        usage: { readings: ['1,234 tokens'], limits: [] },
      },
    ],
  });
  let update!: (value: PhoneState) => void;
  jest.mocked(createPhoneClient).mockImplementation(({ onChange }) => {
    update = onChange;
    onChange({ ...state, devices: [host] });
    return {
      ready: Promise.resolve(),
      pair: jest.fn(),
      joinInvitation: jest.fn(),
      cancelPair: jest.fn(),
      answer: jest.fn(),
      chat: jest.fn(),
      readReport,
      close: jest.fn(),
    };
  });
  let tree: Renderer.ReactTestRenderer | undefined;
  try {
    await Renderer.act(async () => {
      tree = Renderer.create(
        <Workspace userId="account" email="test@example.test" plan="pro" />,
      );
    });
    const visible = (label: string) =>
      tree!.root
        .findAllByType(Text)
        .some(node => node.props.children === label);
    const button = (label: string) =>
      tree!.root.findAll(
        node =>
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === 'function',
      )[0];
    expect(readReport).not.toHaveBeenCalled();
    await Renderer.act(async () => button('Agent usage').props.onPress());
    expect(readReport).toHaveBeenLastCalledWith('host', { kind: 'usage' });
    expect(visible('1,234 tokens')).toBe(true);
    await Renderer.act(async () => jest.advanceTimersByTime(60_000));
    expect(readReport).toHaveBeenCalledTimes(2);
    await Renderer.act(async () => button('To-do').props.onPress());
    await Renderer.act(async () => jest.advanceTimersByTime(60_000));
    expect(readReport).toHaveBeenCalledTimes(2);
    await Renderer.act(async () =>
      update({ ...state, devices: [{ ...host, phoneReports: false }] }),
    );
    await Renderer.act(async () => button('Agents').props.onPress());
    expect(visible('1,234 tokens')).toBe(false);
    expect(visible('Not reported')).toBe(true);
  } finally {
    await Renderer.act(() => tree?.unmount());
    jest.useRealTimers();
  }
});

test('keeps a chat draft across tabs and retries the same message after a missed receipt', async () => {
  const original = state.devices[0];
  const host = {
    ...original,
    phoneReports: true,
    tasks: [{ ...original.tasks[0], canSend: true }],
  };
  const chat = jest
    .fn()
    .mockRejectedValueOnce(new Error('Could not confirm delivery.'))
    .mockResolvedValueOnce('queued');
  jest.mocked(createPhoneClient).mockImplementation(({ onChange }) => {
    onChange({ ...state, devices: [host] });
    return {
      ready: Promise.resolve(),
      pair: jest.fn(),
      joinInvitation: jest.fn(),
      cancelPair: jest.fn(),
      close: jest.fn(),
      answer: jest.fn(),
      chat,
      readReport: jest.fn().mockResolvedValue({
        kind: 'session',
        task: 'session',
        activity: [],
        usage: { readings: [], limits: [] },
      }),
    };
  });
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(
      <Workspace userId="account" email="test@example.test" plan="pro" />,
    );
  });
  try {
    const press = async (label: string) => {
      const targets = tree.root.findAll(
        node => typeof node.props.onPress === 'function',
      );
      const button =
        targets.find(node => node.props.accessibilityLabel === label) ??
        targets.find(node =>
          node
            .findAllByType(Text)
            .some(child => child.props.children === label),
        );
      expect(button).toBeDefined();
      await Renderer.act(async () => button?.props.onPress());
    };
    const draft = () =>
      tree.root
        .findAllByType(TextInput)
        .find(node => node.props.testID === 'chat-message')!;
    await press('Review a release');
    await Renderer.act(async () =>
      draft().props.onChangeText('Check both routes'),
    );
    await press('To-do');
    await press('Agents');
    expect(draft().props.value).toBe('Check both routes');
    await press('Send message');
    expect(draft().props.value).toBe('Check both routes');
    expect(
      tree.root
        .findAllByType(Text)
        .some(node => node.props.children === 'Could not confirm delivery.'),
    ).toBe(true);
    await press('Send message');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0]).toEqual(chat.mock.calls[1]);
    expect(chat.mock.calls[0]).toEqual([
      'host',
      'session',
      expect.objectContaining({
        what: 'send-message',
        text: 'Check both routes',
      }),
    ]);
    expect(draft().props.value).toBe('');
    expect(
      tree.root
        .findAllByType(Text)
        .some(node => node.props.children === 'Message queued on Work laptop'),
    ).toBe(true);
  } finally {
    await Renderer.act(() => tree.unmount());
  }
});

test('pairs with a scanned or pasted invitation and waits for computer approval', async () => {
  const guest: PhoneState = { standing: 'alone', link: 'off', devices: [] };
  const invitation = 'togle-pair:v1:' + 'A'.repeat(22) + ':' + 'F'.repeat(64);
  const scanBarcode = jest.mocked(DataScanner.scanBarcode);
  scanBarcode.mockResolvedValueOnce({ format: 'qr', value: invitation });
  scanBarcode.mockRejectedValueOnce(new Error('Camera permission denied.'));
  let update!: (value: PhoneState) => void;
  const joinInvitation = jest.fn(async () => {
    update({ ...guest, link: 'guest', invitation: 'waiting' });
  });
  const cancelPair = jest.fn(() => update(guest));
  jest.mocked(createPhoneClient).mockImplementation(({ onChange }) => {
    update = onChange;
    onChange(guest);
    return {
      ready: Promise.resolve(),
      pair: jest.fn(),
      joinInvitation,
      cancelPair,
      close: jest.fn(),
      answer: jest.fn(),
      chat: jest.fn(),
      readReport: jest.fn(),
    };
  });
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(
      <Workspace userId="account" email="test@example.test" plan="pro" />,
    );
  });
  const shows = (label: string) =>
    tree.root.findAllByType(Text).some(node => node.props.children === label);
  const press = (title: string) =>
    Renderer.act(async () => {
      const button = tree.root
        .findAll(node => typeof node.props.onPress === 'function')
        .find(node =>
          node
            .findAllByType(Text)
            .some(child => child.props.children === title),
        );
      expect(button).toBeDefined();
      await button?.props.onPress();
    });
  try {
    expect(shows('Connect this phone')).toBe(true);
    expect(shows('Work laptop')).toBe(false);
    await press('Scan QR code');
    expect(scanBarcode).toHaveBeenCalledWith({ targetFormats: ['qr'] });
    expect(joinInvitation).toHaveBeenLastCalledWith(invitation);
    expect(shows('Approve this phone on your computer.')).toBe(true);
    expect(shows('Work laptop')).toBe(false);
    await press('Cancel pairing');
    expect(cancelPair).toHaveBeenCalledTimes(1);
    await press('Scan QR code');
    expect(
      shows(
        'Could not scan with the camera. Paste an invitation or show a pairing code instead.',
      ),
    ).toBe(true);
    await press('Paste invitation');
    const field = () =>
      tree.root
        .findAllByType(TextInput)
        .find(node => node.props.accessibilityLabel === 'Pairing invitation')!;
    await Renderer.act(async () => field().props.onChangeText(invitation));
    await press('Use invitation');
    expect(joinInvitation).toHaveBeenCalledTimes(2);
    expect(joinInvitation).toHaveBeenLastCalledWith(invitation);
    await Renderer.act(async () => update(state));
    expect(shows('Connect this phone')).toBe(false);
    expect(shows('Work laptop')).toBe(true);
  } finally {
    await Renderer.act(() => tree.unmount());
  }
});
