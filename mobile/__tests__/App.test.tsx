/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import App from '../App';

jest.mock('../src/account', () => ({ account: undefined }));
jest.mock('../src/device-client', () => ({ createPhoneClient: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaProvider: View, SafeAreaView: View };
});

test('opens sign-in when the account has not been configured', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<App />);
  });
  const labels = tree.root.findAllByType(Text).map(node => node.props.children);
  expect(labels).toContain('Sign in to your Togle account');
  expect(labels).toContain(
    'Togle account sign-in is unavailable in this build.',
  );
  expect(labels).not.toContain('Show pairing code');
  await ReactTestRenderer.act(() => tree.unmount());
});
