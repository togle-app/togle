import React from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
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

describe('reading a conversation', () => {
  const task: Task = {
    key: 's',
    title: 'Check the release build',
    agent: 'Codex',
    state: 'working',
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
    activity: [{ kind: 'agent', id: 1, text: 'The build finished.' }],
  };
  const element = (
    load: jest.Mock,
    props: Partial<React.ComponentProps<typeof Session>> = {},
  ) => (
    <Session
      host={host}
      task={task}
      sessionKey="s"
      title={task.title}
      agent={task.agent}
      request={undefined}
      answers={[]}
      canReply
      active
      loadReport={load}
      onBack={jest.fn()}
      onReply={jest.fn()}
      {...props}
    />
  );
  const wordsOf = (tree: Renderer.ReactTestRenderer) =>
    tree.root.findAllByType(Text).map(node => node.props.children);
  const labelled = (tree: Renderer.ReactTestRenderer, label: string) =>
    tree.root.findAll(node => node.props.accessibilityLabel === label);
  const EMPTY = 'This agent hasn’t shared messages from this session.';

  test('shows that it is loading, and says nothing about an empty session before it knows', async () => {
    let arrive!: (value: PhoneSessionReport) => void;
    const load = jest.fn(
      () => new Promise<PhoneSessionReport>(resolve => (arrive = resolve)),
    );
    let tree!: Renderer.ReactTestRenderer;
    await Renderer.act(async () => {
      tree = Renderer.create(element(load));
    });
    expect(labelled(tree, 'Loading the conversation').length).toBeGreaterThan(
      0,
    );
    expect(wordsOf(tree)).not.toContain(EMPTY);
    await Renderer.act(async () => arrive({ ...report, activity: [] }));
    expect(labelled(tree, 'Loading the conversation')).toHaveLength(0);
    expect(wordsOf(tree)).toContain(EMPTY);
    await Renderer.act(() => tree.unmount());
  });

  test('says when the conversation could not be loaded and reads it again on Try again', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('That report is unavailable.'))
      .mockResolvedValueOnce(report);
    let tree!: Renderer.ReactTestRenderer;
    await Renderer.act(async () => {
      tree = Renderer.create(element(load));
    });
    expect(wordsOf(tree)).toContain('Could not load the conversation.');
    expect(wordsOf(tree)).not.toContain(EMPTY);
    expect(labelled(tree, 'Loading the conversation')).toHaveLength(0);
    const again = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node =>
        node
          .findAllByType(Text)
          .some(child => child.props.children === 'Try again'),
      );
    await Renderer.act(async () => again?.props.onPress());
    expect(load).toHaveBeenCalledTimes(2);
    expect(wordsOf(tree)).not.toContain('Could not load the conversation.');
    await Renderer.act(() => tree.unmount());
  });

  test('keeps what was read while the computer is offline, and hides it when the session is no longer shared', async () => {
    const load = jest.fn().mockResolvedValue(report);
    let tree!: Renderer.ReactTestRenderer;
    await Renderer.act(async () => {
      tree = Renderer.create(element(load));
    });
    // A message is drawn as its Markdown parts: read them together.
    const said = () =>
      tree.root
        .findAllByType(Text)
        .some(
          node =>
            [node.props.children].flat().join('') === 'The build finished.',
        );
    expect(said()).toBe(true);

    // The computer goes to sleep: it lists no session any more, the page stays as it was read.
    const offline = { ...host, online: false, canAct: false, tasks: [] };
    await Renderer.act(async () =>
      tree.update(element(load, { host: offline, task: undefined })),
    );
    expect(said()).toBe(true);
    expect(wordsOf(tree)).toContain('Build server is offline.');
    expect(wordsOf(tree)).toContain('Sending unavailable');
    expect(load).toHaveBeenCalledTimes(1);

    // It is back and no longer lists the session: what it shared before is not shown on.
    await Renderer.act(async () =>
      tree.update(
        element(load, { host: { ...host, tasks: [] }, task: undefined }),
      ),
    );
    expect(said()).toBe(false);
    expect(wordsOf(tree)).toContain('This session is no longer shared.');

    // It stops sharing its sessions' contents: the same.
    await Renderer.act(async () => tree.update(element(load)));
    expect(said()).toBe(true);
    await Renderer.act(async () =>
      tree.update(element(load, { host: { ...host, phoneReports: false } })),
    );
    expect(said()).toBe(false);
    await Renderer.act(() => tree.unmount());
  });

  test('a session opened while its computer is offline says that nothing was saved', async () => {
    const load = jest.fn().mockResolvedValue(report);
    let tree!: Renderer.ReactTestRenderer;
    await Renderer.act(async () => {
      tree = Renderer.create(
        element(load, {
          host: { ...host, online: false, canAct: false, tasks: [] },
          task: undefined,
        }),
      );
    });
    expect(load).not.toHaveBeenCalled();
    expect(
      tree.root
        .findAllByType(Text)
        .some(node =>
          String(node.props.children).includes(
            'No conversation was saved on this phone',
          ),
        ),
    ).toBe(true);
    await Renderer.act(() => tree.unmount());
  });

  test('"Message sent" goes after a moment, and the box stays above the keyboard', async () => {
    jest.useFakeTimers();
    const listeners: Record<string, (event?: unknown) => void> = {};
    const listen = jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((name, handler) => {
        listeners[name] = handler as (event?: unknown) => void;
        return { remove: jest.fn() } as never;
      });
    const chat = jest.fn().mockResolvedValue('sent');
    let draft = { text: 'Run the lint step too.' };
    let tree: Renderer.ReactTestRenderer | undefined;
    try {
      await Renderer.act(async () => {
        tree = Renderer.create(
          element(jest.fn().mockResolvedValue(report), {
            task: { ...task, canSend: true },
            onChat: chat,
            draft,
            changeDraft: update => {
              draft = update(draft);
            },
          }),
        );
      });
      // The page sits under a top bar of 84 and is 700 high; the tabs take the rest of an 848 screen.
      const page = tree!.root.findAll(
        node => typeof node.instance?.measureInWindow === 'function',
      )[0];
      page.instance.measureInWindow = (
        done: (x: number, y: number, w: number, h: number) => void,
      ) => done(0, 84, 400, 700);
      const root = () =>
        StyleSheet.flatten(tree!.root.findAllByType(View)[0].props.style);
      expect(root().paddingBottom).toBe(0);
      const shown =
        listeners.keyboardWillChangeFrame ?? listeners.keyboardDidShow;
      const hidden = listeners.keyboardWillHide ?? listeners.keyboardDidHide;
      // The keyboard's top edge is at 500 on the screen: the page ends at 784, so 284 of it would be covered.
      await Renderer.act(async () =>
        shown({ endCoordinates: { screenY: 500 } }),
      );
      expect(root().paddingBottom).toBe(284);
      await Renderer.act(async () => hidden());
      expect(root().paddingBottom).toBe(0);

      const send = tree!.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Send message' &&
          typeof node.props.onPress === 'function',
      )[0];
      await Renderer.act(async () => send.props.onPress());
      expect(chat).toHaveBeenCalledTimes(1);
      expect(wordsOf(tree!)).toContain('Message sent');
      await Renderer.act(async () => jest.advanceTimersByTime(5000));
      expect(wordsOf(tree!)).not.toContain('Message sent');
    } finally {
      await Renderer.act(() => tree?.unmount());
      listen.mockRestore();
      jest.useRealTimers();
    }
  });
});
