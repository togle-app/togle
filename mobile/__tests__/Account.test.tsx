import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Renderer from 'react-test-renderer';
import App from '../App';
import { account, proWaitlist } from '../src/account';
import { createPhoneClient } from '../src/device-client';
import { SignIn, signInProblem } from '../src/SignIn';

jest.mock('../src/account', () => {
  const session = { user: { id: 'account', email: 'test@example.test' } };
  return {
    account: {
      auth: {
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe() {} } },
        }),
        getSession: async () => ({ data: { session }, error: null }),
        startAutoRefresh() {},
        stopAutoRefresh() {},
        signOut: jest.fn(async () => ({ error: null })),
        signInWithOtp: jest.fn(),
        verifyOtp: jest.fn(),
      },
    },
    readPlan: jest.fn(async () => 'free'),
    proWaitlist: jest.fn(),
    deviceStore: () => ({ read: async () => null, write: async () => {} }),
    tokenFor: async () => 'test-token',
  };
});
jest.mock('../src/config.generated', () => ({
  config: { relay: 'ws://test.invalid/v1' },
}));
jest.mock('../src/device-client', () => ({ createPhoneClient: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const { createContext } = require('react');
  const Plain = require('react-native').View;
  // A phone with a status bar of 24 and a gesture bar of 16.
  return {
    SafeAreaProvider: Plain,
    SafeAreaView: Plain,
    SafeAreaInsetsContext: createContext({
      top: 24,
      bottom: 16,
      left: 0,
      right: 0,
    }),
  };
});

test('an account on the Free plan can join and leave the Pro waitlist, on the page and in the account sheet', async () => {
  const waitlist = jest.mocked(proWaitlist);
  waitlist.mockImplementation(async action => action === 'join');
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(<App />);
  });
  const words = () =>
    tree.root.findAllByType(Text).map(node => node.props.children);
  const buttons = (label: string) =>
    tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .filter(
        node =>
          node.props.accessibilityLabel === label ||
          node
            .findAllByType(Text)
            .some(child => child.props.children === label),
      );
  const press = (label: string) =>
    Renderer.act(async () => {
      expect(buttons(label).length).toBeGreaterThan(0);
      await buttons(label)[0].props.onPress();
    });

  // The Free plan pairs with no computer: the page says what Pro is for and how to hear about it.
  expect(createPhoneClient).not.toHaveBeenCalled();
  expect(waitlist).toHaveBeenLastCalledWith('status');
  expect(words()).toContain('See your agents with Togle Pro');
  expect(words()).not.toContain('You’re on the Pro waitlist.');

  await press('Join waitlist');
  expect(waitlist).toHaveBeenLastCalledWith('join');
  expect(words()).toContain('You’re on the Pro waitlist.');
  expect(buttons('Join waitlist')).toHaveLength(0);

  await press('View account');
  expect(words()).toContain('Togle account');
  expect(words()).toContain('test@example.test');
  expect(words()).toContain('Free');
  expect(words()).toContain('Close');
  expect(words()).not.toContain('Close account');
  // Once on the page, once in the sheet.
  expect(buttons('Leave waitlist').length).toBeGreaterThanOrEqual(2);

  await press('Leave waitlist');
  expect(waitlist).toHaveBeenLastCalledWith('leave');
  expect(words()).not.toContain('You’re on the Pro waitlist.');
  expect(buttons('Join waitlist').length).toBeGreaterThanOrEqual(2);
  await Renderer.act(() => tree.unmount());
});

test('a waitlist that does not answer offers to try again and keeps the rest of the page', async () => {
  const waitlist = jest.mocked(proWaitlist);
  waitlist.mockReset();
  waitlist.mockRejectedValueOnce(
    new Error('The Togle Pro waitlist is unavailable. Try again.'),
  );
  waitlist.mockResolvedValueOnce(true);
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(<App />);
  });
  const words = () =>
    tree.root.findAllByType(Text).map(node => node.props.children);
  expect(words()).toContain('See your agents with Togle Pro');
  expect(words()).toContain(
    'The Togle Pro waitlist is unavailable. Try again.',
  );
  const again = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node =>
      node
        .findAllByType(Text)
        .some(child => child.props.children === 'Try again'),
    );
  expect(again).toBeDefined();
  await Renderer.act(async () => again?.props.onPress());
  expect(waitlist).toHaveBeenLastCalledWith('status');
  expect(words()).toContain('You’re on the Pro waitlist.');
  await Renderer.act(() => tree.unmount());
});

test('sign-in problems are told in plain words', () => {
  expect(signInProblem({ code: 'otp_expired', status: 403 }, 'verify')).toBe(
    'That code is wrong or has expired. Check it, or ask for a new one.',
  );
  expect(
    signInProblem({ code: 'over_email_send_rate_limit', status: 429 }, 'send'),
  ).toBe('Wait a minute, then ask for a new code.');
  expect(
    signInProblem({ name: 'AuthRetryableFetchError', status: 0 }, 'send'),
  ).toBe('Could not reach Togle. Check your connection and try again.');
  expect(signInProblem({ code: 'email_address_invalid' }, 'send')).toBe(
    'Check the email address and try again.',
  );
  // Whatever else the account service says is not shown as it is.
  expect(
    signInProblem(new Error('Database error saving new user'), 'send'),
  ).toBe('Could not send the code. Try again.');
  expect(signInProblem(new Error('unexpected_failure'), 'verify')).toBe(
    'Sign-in did not finish. Try again.',
  );
  expect(signInProblem(undefined, 'verify')).toBe(
    'Sign-in did not finish. Try again.',
  );
});

test('the sign-in page tells a failed code in plain words, not as the account service wrote it', async () => {
  const send = jest.mocked(account!.auth.signInWithOtp);
  send.mockRejectedValueOnce(new Error('Database error saving new user'));
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(<SignIn />);
  });
  const words = () =>
    tree.root.findAllByType(Text).map(node => node.props.children);
  const email = tree.root
    .findAllByType(TextInput)
    .find(node => node.props.testID === 'account-email')!;
  await Renderer.act(async () => email.props.onChangeText('test@example.test'));
  const ask = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node =>
      node
        .findAllByType(Text)
        .some(child => child.props.children === 'Email me a code'),
    );
  await Renderer.act(async () => ask?.props.onPress());
  expect(send).toHaveBeenCalledTimes(1);
  expect(words()).toContain('Could not send the code. Try again.');
  expect(words()).not.toContain('Database error saving new user');
  await Renderer.act(() => tree.unmount());
});

test('asking for the code again says that a new one is on its way', async () => {
  const send = jest.mocked(account!.auth.signInWithOtp);
  send.mockReset();
  send.mockResolvedValue({ error: null } as never);
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(<SignIn />);
  });
  const words = () =>
    tree.root.findAllByType(Text).map(node => node.props.children);
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
  const email = tree.root
    .findAllByType(TextInput)
    .find(node => node.props.testID === 'account-email')!;
  await Renderer.act(async () => email.props.onChangeText('test@example.test'));
  await press('Email me a code');
  expect(words()).toContain('Check your email');
  expect(words()).not.toContain('A new code is on its way.');
  // The cursor is in the code's box without another press.
  const code = tree.root
    .findAllByType(TextInput)
    .find(node => node.props.testID === 'account-code')!;
  expect(code.props.autoFocus).toBe(true);
  await press('Resend code');
  expect(send).toHaveBeenCalledTimes(2);
  expect(words()).toContain('A new code is on its way.');
  await press('Use another address');
  expect(words()).not.toContain('A new code is on its way.');
  await Renderer.act(() => tree.unmount());
});

test('the top bar runs up under the status bar and the tabs run down under the gesture bar', async () => {
  jest.mocked(proWaitlist).mockResolvedValue(false);
  let tree!: Renderer.ReactTestRenderer;
  await Renderer.act(async () => {
    tree = Renderer.create(<App />);
  });
  const styleOf = (holds: string) => {
    const view = tree.root
      .findAllByType(View)
      .filter(node =>
        node.findAllByType(Text).some(child => child.props.children === holds),
      )
      .at(-1);
    return StyleSheet.flatten(view?.props.style);
  };
  // The innermost views that hold the name and the tabs are rows inside the bars: walk out to the padded ones.
  const padded = (holds: string, side: 'paddingTop' | 'paddingBottom') =>
    tree.root
      .findAllByType(View)
      .filter(node =>
        node.findAllByType(Text).some(child => child.props.children === holds),
      )
      .map(node => StyleSheet.flatten(node.props.style)?.[side])
      .filter(value => typeof value === 'number' && value > 0);
  expect(styleOf('Togle')).toBeDefined();
  expect(padded('Togle', 'paddingTop')).toContain(24);
  expect(padded('To-do', 'paddingBottom')).toContain(16);
  await Renderer.act(() => tree.unmount());
});
