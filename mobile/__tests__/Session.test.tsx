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
  const agent = tree.root
    .findAllByType(Text)
    .find(node => node.props.children?.[0] === 'Codex');
  expect(
    agent?.findAllByType(Text).some(node => node.props.children === ' · Fast'),
  ).toBe(true);
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
