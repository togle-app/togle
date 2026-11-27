import React, { useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { account } from './account';
import { Block, Button, ErrorMessage, useGutter, useTheme } from './ui';

/**
 * What to tell a person when sending or checking the code failed. The account service words its errors for developers
 * ("Token has expired or is invalid"), so its code and status are read and the sentence is ours.
 */
export function signInProblem(failure: unknown, action: 'send' | 'verify') {
  const problem = (failure ?? {}) as {
    code?: unknown;
    status?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const code = typeof problem.code === 'string' ? problem.code : '';
  const said =
    typeof problem.message === 'string' ? problem.message.toLowerCase() : '';
  if (problem.status === 429 || code.startsWith('over_'))
    return 'Wait a minute, then ask for a new code.';
  if (
    problem.name === 'AuthRetryableFetchError' ||
    problem.status === 0 ||
    said.includes('network request failed')
  )
    return 'Could not reach Togle. Check your connection and try again.';
  if (action === 'verify') {
    return code === 'otp_expired' || problem.status === 403
      ? 'That code is wrong or has expired. Check it, or ask for a new one.'
      : 'Sign-in did not finish. Try again.';
  }
  return code === 'email_address_invalid' || code === 'validation_failed'
    ? 'Check the email address and try again.'
    : 'Could not send the code. Try again.';
}

export function SignIn() {
  const { s, colors } = useTheme();
  const gutter = useGutter();
  const { width, height } = useWindowDimensions();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const address = email.trim();
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address);
  // The card sits a little down the page and takes more room inside on a tablet.
  const card = {
    marginTop: Math.round(Math.min(70, Math.max(8, height * 0.06))),
    padding: Math.round(Math.min(36, Math.max(20, width / 20))),
  };

  async function run(action: 'send' | 'verify') {
    if (
      !account ||
      busy ||
      !validEmail ||
      (action === 'verify' && code.length < 6)
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result =
        action === 'send'
          ? await account.auth.signInWithOtp({ email: address })
          : await account.auth.verifyOtp({
              email: address,
              token: code,
              type: 'email',
            });
      if (result.error) throw result.error;
      Keyboard.dismiss();
      if (action === 'send') {
        setSent(true);
        setCode('');
      }
    } catch (failure) {
      setError(signInProblem(failure, action));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          s.page,
          styles.form,
          { paddingHorizontal: gutter, maxWidth: 460 + 2 * gutter },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Block style={[styles.card, card]}>
          <Text accessibilityRole="header" style={[s.h1, styles.heading]}>
            {sent ? 'Check your email' : 'Sign in to your Togle account'}
          </Text>
          <Text style={s.secondary}>
            {sent
              ? 'Enter the sign-in code sent to ' + address + '.'
              : 'Use the same account as your computers. With Togle Pro, their agents appear here.'}
          </Text>
          {account ? (
            <View style={styles.fields}>
              <View style={styles.field}>
                <Text style={s.label}>{sent ? 'Code' : 'Email'}</Text>
                {sent ? (
                  <TextInput
                    accessibilityLabel="Code from the email"
                    testID="account-code"
                    autoComplete="one-time-code"
                    keyboardType="number-pad"
                    maxLength={10}
                    onChangeText={value => setCode(value.replace(/\D/g, ''))}
                    editable={!busy}
                    style={s.field}
                    value={code}
                    returnKeyType="go"
                    onSubmitEditing={() => run('verify')}
                  />
                ) : (
                  <TextInput
                    accessibilityLabel="Email address"
                    testID="account-email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    keyboardType="email-address"
                    placeholder="you@example.com"
                    placeholderTextColor={colors.muted}
                    maxLength={254}
                    editable={!busy}
                    onChangeText={setEmail}
                    style={s.field}
                    value={email}
                    returnKeyType="go"
                    onSubmitEditing={() => run('send')}
                  />
                )}
              </View>
              <ErrorMessage message={error} />
              <Button
                title={
                  busy ? 'Please wait…' : sent ? 'Sign in' : 'Email me a code'
                }
                primary
                disabled={busy || (sent ? code.length < 6 : !validEmail)}
                onPress={() => run(sent ? 'verify' : 'send')}
              />
              {sent && (
                <View style={[s.actions, styles.links]}>
                  <Button
                    title="Resend code"
                    link
                    disabled={busy}
                    onPress={() => run('send')}
                  />
                  <Button
                    title="Use another address"
                    link
                    disabled={busy}
                    onPress={() => {
                      setSent(false);
                      setCode('');
                      setError('');
                    }}
                  />
                </View>
              )}
            </View>
          ) : (
            <Text style={s.secondary}>
              Togle account sign-in is unavailable in this build.
            </Text>
          )}
        </Block>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  form: { alignSelf: 'center', width: '100%' },
  card: { gap: 20 },
  heading: { fontSize: 30, letterSpacing: -1.35 },
  fields: { gap: 14 },
  field: { gap: 7 },
  links: { justifyContent: 'center' },
});
