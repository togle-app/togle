import React, { useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { account } from './account';
import { Block, Button, ErrorMessage, useTheme } from './ui';

export function SignIn() {
  const { s, colors } = useTheme();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const address = email.trim();
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address);

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
      setError(
        failure instanceof Error
          ? failure.message
          : 'Sign-in did not finish. Try again.',
      );
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
        contentContainerStyle={[s.page, styles.form]}
        keyboardShouldPersistTaps="handled"
      >
        <Block>
          <Text accessibilityRole="header" style={s.h1}>
            {sent ? 'Check your email' : 'Sign in to Togle'}
          </Text>
          <Text style={s.secondary}>
            {sent
              ? 'Enter the sign-in code sent to ' + address + '.'
              : 'Use the same Togle account as your computers.'}
          </Text>
          {account ? (
            <>
              <Text style={s.label}>{sent ? 'Email code' : 'Email'}</Text>
              {sent ? (
                <TextInput
                  accessibilityLabel="Email code"
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
                  accessibilityLabel="Email"
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
                <View style={s.actions}>
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
            </>
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
  form: { alignSelf: 'center', width: '100%', maxWidth: 488 },
});
