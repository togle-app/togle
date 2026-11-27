import React from 'react';
import { Text, View } from 'react-native';
import Renderer from 'react-test-renderer';
import type { Answer } from '../src/ChatThread';
import type { Device, Request, Task } from '../src/device-client';
import type { PhoneSessionReport } from '../src/phone-report';
import { Session } from '../src/Session';

test('shows Fast inline with the agent and keeps a phone answer in conversation order', async () => {
  const task: Task = {
    key: 's',
    title: 'Review the layout',
    agent: 'Codex',
    state: 'waiting',
    folder: 'website',
    line: '',
    mine: true,
    pending: [],
  };
  const host: Device = {
    device: 'desktop',
    name: 'Work PC',
    role: 'computer',
    online: true,
    canAct: true,
    phoneReports: true,
    tasks: [task],
  };
  const request: Request = {
    id: 'q',
    kind: 'question',
    question: 'Which theme?',
    choices: ['Green', 'Blue'],
  };
  const at = Date.now();
  const report: PhoneSessionReport = {
    kind: 'session',
    task: 's',
    model: 'Fast',
    usage: { readings: ['600 tokens'], limits: [] },
    activity: [
      {
        kind: 'you',
        id: 1,
        at,
        text: 'Review both layouts.',
        delivery: 'delivered',
      },
      { kind: 'work', id: 2, at, text: '1 step: ran 1 command' },
      {
        kind: 'agent',
        id: 3,
        at,
        text: '**Both layouts pass.**\n\n```js\ntheme = "system";\n```',
      },
    ],
  };
  const loadReport = jest.fn().mockResolvedValue(report);
  const reply = jest.fn();
  const render = (next: Task, pending?: Request, answers: Answer[] = []) => (
    <Session
      host={host}
      task={next}
      title={task.title}
      agent={task.agent}
      request={pending}
      answers={answers}
      canReply
      active
      loadReport={loadReport}
      onBack={jest.fn()}
      onReply={reply}
    />
  );
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(render(task, request));
  });
  const messages = () =>
    tree.root
      .findAllByType(View)
      .map(node => node.props.testID)
      .filter(id => id?.startsWith('chat-'));
  const receipts = (label: string) =>
    tree.root
      .findAllByType(View)
      .filter(node => node.props.accessibilityLabel === label);
  expect(messages()).toEqual([
    'chat-prompt',
    'chat-work',
    'chat-agent',
    'chat-question',
  ]);
  const identity = tree.root
    .findAllByType(View)
    .find(node => node.props.testID === 'session-identity');
  expect(
    identity?.findAllByType(Text).map(node => node.props.children),
  ).toEqual(expect.arrayContaining(['Codex', 'Fast']));
  expect(loadReport).toHaveBeenLastCalledWith('desktop', {
    kind: 'session',
    task: 's',
    view: 'chat',
  });
  const option = tree.root.findAll(
    node =>
      node.props.testID === 'answer-choice-0' &&
      typeof node.props.onPress === 'function',
  )[0];
  await Renderer.act(async () => option.props.onPress());
  expect(reply).toHaveBeenCalledWith(0, '["agent",3]');
  const answer: Answer = {
    request: 'q',
    question: 'Which theme?',
    choice: 'Green',
    after: reply.mock.calls[0][1],
    phase: 'sent',
    at: at + 1,
  };
  loadReport.mockResolvedValue({
    ...report,
    activity: [
      ...report.activity,
      { kind: 'agent', id: 4, at: at + 2, text: 'Green it is.' },
    ],
  });
  await Renderer.act(async () =>
    tree.update(render({ ...task, state: 'idle' }, undefined, [answer])),
  );
  expect(messages()).toEqual([
    'chat-prompt',
    'chat-work',
    'chat-agent',
    'chat-prompt',
    'chat-agent',
  ]);
  expect(receipts('Sent to server')).toHaveLength(1);
  expect(receipts('Delivered to agent')).toHaveLength(1);
  loadReport.mockResolvedValue({
    ...report,
    activity: [
      ...report.activity,
      {
        kind: 'you',
        id: 4,
        at: at + 1,
        replyTo: 'q',
        delivery: 'delivered',
        text: 'Replying to “Which theme?”: Green',
      },
      { kind: 'agent', id: 5, at: at + 2, text: 'Green it is.' },
    ],
  });
  await Renderer.act(async () =>
    tree.update(render({ ...task, state: 'working' }, undefined, [answer])),
  );
  expect(messages()).toEqual([
    'chat-prompt',
    'chat-work',
    'chat-agent',
    'chat-prompt',
    'chat-agent',
  ]);
  expect(receipts('Sent to server')).toHaveLength(0);
  expect(receipts('Delivered to agent')).toHaveLength(2);
  await Renderer.act(() => tree.unmount());
});

describe('a session this phone cannot answer or write to', () => {
  const task: Task = {
    key: 's',
    title: 'Choose a report format',
    agent: 'Hermes',
    state: 'waiting',
    folder: 'release',
    line: '',
    mine: true,
    pending: [],
  };
  const host: Device = {
    device: 'server',
    name: 'Build server',
    role: 'computer',
    online: true,
    canAct: true,
    phoneReports: true,
    tasks: [task],
  };
  const report: PhoneSessionReport = {
    kind: 'session',
    task: 's',
    usage: { readings: [], limits: [] },
    activity: [{ kind: 'you', id: 1, text: 'Prepare the release report.' }],
  };
  async function open(
    props: Partial<React.ComponentProps<typeof Session>> = {},
  ) {
    let tree!: Renderer.ReactTestRenderer;
    await Renderer.act(async () => {
      tree = Renderer.create(
        <Session
          host={host}
          task={task}
          title={task.title}
          agent={task.agent}
          request={undefined}
          answers={[]}
          canReply
          active
          loadReport={jest.fn().mockResolvedValue(report)}
          onBack={jest.fn()}
          onReply={jest.fn()}
          {...props}
        />,
      );
    });
    const words = () =>
      tree.root.findAllByType(Text).map(node => node.props.children);
    const labelled = (label: string) =>
      tree.root.findAll(
        node =>
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === 'function',
      );
    return { tree, words, labelled };
  }

  test('says on which computer to continue when the agent waits for something the phone was not given', async () => {
    const { tree, words, labelled } = await open();
    expect(words()).toContain('Continue on Build server');
    expect(words()).toContain('Hermes is waiting for an answer there.');
    // The card says where to go: no second line under it, and nothing to stop while the computer takes no messages.
    expect(words()).not.toContain('Reply on Build server');
    expect(words()).not.toContain('Stop task');
    expect(labelled('Stop task')).toHaveLength(0);
    await Renderer.act(() => tree.unmount());
  });

  test('offers Stop task once, in the card, when the computer takes it from this phone', async () => {
    const chat = jest.fn().mockResolvedValue(undefined);
    const { tree, words, labelled } = await open({
      task: { ...task, canSend: true, canStop: true },
      onChat: chat,
      changeDraft: jest.fn(),
    });
    expect(words()).toContain('Continue on Build server');
    expect(labelled('Stop task')).toHaveLength(0);
    const stop = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node =>
        node
          .findAllByType(Text)
          .some(child => child.props.children === 'Stop task'),
      );
    expect(stop).toBeDefined();
    await Renderer.act(async () => stop?.props.onPress());
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith({ what: 'stop' });
    await Renderer.act(() => tree.unmount());
  });

  test('keeps Stop beside the message box while the agent works', async () => {
    const { tree, words, labelled } = await open({
      task: { ...task, state: 'working', canSend: true, canStop: true },
      onChat: jest.fn(),
      changeDraft: jest.fn(),
    });
    expect(words()).not.toContain('Continue on Build server');
    expect(labelled('Stop task')).toHaveLength(1);
    await Renderer.act(() => tree.unmount());
  });

  test('names the computer where replies are allowed when they are off for this phone', async () => {
    const working: Task = { ...task, state: 'working' };
    const off = await open({ task: working, canReply: false });
    expect(off.words()).toContain('Phone replies are off');
    expect(off.words()).toContain(
      'Allow replies for this phone in Togle on Build server.',
    );
    await Renderer.act(() => off.tree.unmount());

    const on = await open({ task: working });
    expect(on.words()).toContain('Reply on Build server');
    expect(on.words()).not.toContain('Phone replies are off');
    await Renderer.act(() => on.tree.unmount());
  });

  test('says that nothing can be sent while the computer is offline', async () => {
    const { tree, words } = await open({
      host: { ...host, online: false, canAct: false, tasks: [] },
      task: undefined,
      canReply: false,
    });
    expect(words()).toContain('Build server is offline.');
    expect(words()).toContain('Sending unavailable');
    expect(words()).not.toContain('Phone replies are off');
    await Renderer.act(() => tree.unmount());
  });
});
