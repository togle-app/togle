import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { account, readPlan, type Plan } from './src/account';
import { SignIn } from './src/SignIn';
import {
  Block,
  Button,
  ErrorMessage,
  Palette,
  Sheet,
  useTheme,
} from './src/ui';
import { Workspace } from './src/Workspace';

const logo = require('./assets/togle.png');
type PlanStatus =
  | { plan: Plan; error?: never }
  | { plan?: never; error: string };

export default function App() {
  return (
    <SafeAreaProvider>
      <Palette>
        <Togle />
      </Palette>
    </SafeAreaProvider>
  );
}

function Togle() {
  const { s, colors, isDark } = useTheme();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [authError, setAuthError] = useState('');
  const [retry, setRetry] = useState(0);
  const [showAccount, setShowAccount] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const userId = session?.user.id;
  const email = session?.user.email;
  const [entitlement, setEntitlement] = useState<{
    user: string;
    status: PlanStatus;
  }>();
  const current =
    entitlement?.user === userId ? entitlement?.status : undefined;

  useEffect(() => {
    if (!account) {
      setSession(null);
      return;
    }
    const client = account;
    let active = true;
    let sessionChanged = false;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, next) => {
      if (!active || event === 'INITIAL_SESSION') return;
      sessionChanged = true;
      setAuthError('');
      setSession(next);
      if (!next) setShowAccount(false);
    });
    client.auth.getSession().then(
      ({ data, error }) => {
        if (!active || sessionChanged) return;
        setAuthError(error ? 'Could not restore your account. Try again.' : '');
        setSession(data.session);
      },
      () => {
        if (!active || sessionChanged) return;
        setSession(null);
        setAuthError('Could not open your account. Try again.');
      },
    );
    const refresh = (state: string) => {
      if (state === 'active') client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
    };
    if (AppState.currentState) refresh(AppState.currentState);
    const listener = AppState.addEventListener('change', refresh);
    return () => {
      active = false;
      subscription.unsubscribe();
      listener.remove();
      client.auth.stopAutoRefresh();
    };
  }, [retry]);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    let request = 0;
    const check = () => {
      const revision = ++request;
      const update = (status: PlanStatus) => {
        if (active && revision === request) {
          setEntitlement(previous =>
            status.error && previous?.user === userId && previous.status.plan
              ? previous
              : { user: userId, status },
          );
        }
      };
      readPlan().then(
        plan => update({ plan }),
        error =>
          update({
            error:
              error instanceof Error
                ? error.message
                : 'Could not check your Togle plan.',
          }),
      );
    };
    check();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') check();
    });
    return () => {
      active = false;
      listener.remove();
    };
  }, [userId, retry]);

  async function signOut() {
    if (!account || signingOut) return;
    setSigningOut(true);
    setSignOutError('');
    try {
      const result = await account.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
      setShowAccount(false);
      setEntitlement(undefined);
    } catch {
      setSignOutError('Could not sign out. Try again.');
    } finally {
      setSigningOut(false);
    }
  }

  const tryAgain = () => {
    setAuthError('');
    setEntitlement(undefined);
    setRetry(value => value + 1);
  };

  return (
    <SafeAreaView style={s.fill}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <View style={s.header}>
        <View style={s.topRow}>
          <Image source={logo} style={s.logo} />
          <Text style={s.wordmark}>Togle</Text>
        </View>
        {email && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Togle account"
            accessibilityState={{ expanded: showAccount }}
            onPress={() => {
              Keyboard.dismiss();
              setSignOutError('');
              setShowAccount(true);
            }}
            style={[styles.avatar, { backgroundColor: colors.tint }]}
          >
            <Text style={[s.label, { color: colors.accent }]}>
              {email.slice(0, 2).toUpperCase()}
            </Text>
          </Pressable>
        )}
      </View>
      {session === undefined ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : authError ? (
        <View style={s.page}>
          <Block>
            <ErrorMessage message={authError} />
            <Button title="Try again" onPress={tryAgain} />
          </Block>
        </View>
      ) : !userId || !email ? (
        <SignIn />
      ) : (
        <>
          <View style={s.fill}>
            {current?.plan ? (
              <Workspace
                key={userId}
                userId={userId}
                email={email}
                plan={current.plan}
              />
            ) : current?.error ? (
              <View style={s.page}>
                <Block>
                  <ErrorMessage message={current.error} />
                  <Button title="Try again" onPress={tryAgain} />
                </Block>
              </View>
            ) : (
              <View style={s.loading}>
                <ActivityIndicator color={colors.accent} />
              </View>
            )}
          </View>
          {showAccount && (
            <Sheet onClose={() => setShowAccount(false)}>
              <Text accessibilityRole="header" style={s.h1}>
                Togle account
              </Text>
              <Text selectable style={s.text}>
                {email}
              </Text>
              {current?.plan && (
                <View style={s.topRow}>
                  <Text style={s.label}>Plan</Text>
                  <Text style={s.secondary}>
                    {current.plan === 'free'
                      ? 'Free'
                      : current.plan === 'trial'
                      ? 'Togle Pro trial'
                      : 'Togle Pro access'}
                  </Text>
                </View>
              )}
              <ErrorMessage message={signOutError} />
              <Button
                title={signingOut ? 'Signing out…' : 'Sign out'}
                disabled={signingOut}
                onPress={signOut}
              />
              <Button
                title="Close account"
                link
                onPress={() => setShowAccount(false)}
              />
            </Sheet>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
