import React from 'react';
import { Text } from 'react-native';
import Renderer from 'react-test-renderer';
import { Agents } from '../src/Agents';
import type { Device, Task } from '../src/device-client';

const task = (key: string, folder: string, state: Task['state']): Task => ({
  key,
  title: 'Task ' + key,
  agent: 'Codex',
  folder,
  state,
  line: '',
  mine: true,
  pending: [],
});
const device = (tasks: Task[]): Device => ({
  device: 'host',
  name: 'Work laptop',
  role: 'computer',
  online: true,
  canAct: true,
  tasks,
});

async function show(devices: Device[]) {
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(
      <Agents
        devices={devices}
        active
        loadReport={jest.fn()}
        onOpen={jest.fn()}
      />,
    );
  });
  const words = () =>
    tree.root.findAllByType(Text).map(node => node.props.children);
  const press = (label: string) =>
    Renderer.act(async () => {
      const targets = tree.root.findAll(
        node => typeof node.props.onPress === 'function',
      );
      const target =
        targets.find(node => node.props.accessibilityLabel === label) ??
        targets.find(node =>
          node
            .findAllByType(Text)
            .some(child => child.props.children === label),
        );
      expect(target).toBeDefined();
      await target?.props.onPress();
    });
  return { tree, words, press };
}

test('a computer with one folder lists its sessions without a folder line, and a row names its folder', async () => {
  const { tree, words } = await show([
    device([task('a', 'website', 'working'), task('b', 'website', 'idle')]),
  ]);
  expect(words()).toContain('1 agent across 1 device');
  expect(words()).toContain('Codex · website');
  expect(words()).not.toContain('website');
  await Renderer.act(() => tree.unmount());
});

test('a computer with several folders keeps a fold for each', async () => {
  const { tree, words } = await show([
    device([task('a', 'website', 'working'), task('b', 'docs', 'idle')]),
  ]);
  expect(words()).toEqual(expect.arrayContaining(['website', 'docs']));
  expect(words()).toContain('Task b');
  const fold = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node =>
      node.findAllByType(Text).some(child => child.props.children === 'docs'),
    );
  await Renderer.act(async () => fold?.props.onPress());
  expect(words()).not.toContain('Task b');
  expect(words()).toContain('Task a');
  await Renderer.act(() => tree.unmount());
});

test('a filter with nothing in it says so and leads back to all agents', async () => {
  const { tree, words, press } = await show([
    device([task('a', 'website', 'working')]),
  ]);
  await press('Waiting 0');
  expect(words()).toContain('No agents waiting');
  expect(words()).not.toContain('Task a');
  await press('Show all agents');
  expect(words()).toContain('Task a');
  expect(words()).not.toContain('No agents waiting');
  await Renderer.act(() => tree.unmount());
});
