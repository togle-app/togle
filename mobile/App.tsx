import React, { useCallback, useEffect, useState } from 'react';
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
import { account, proWaitlist, readPlan, type Plan } from './src/account';
import { SignIn } from './src/SignIn';
import {
  Block,
  Button,
  ErrorMessage,
  Palette,
  Sheet,
  useGutter,
  useTheme,
} from './src/ui';
import { Workspace, type Waitlist } from './src/Workspace';

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
  const gutter = useGutter();
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
  const free = current?.plan === 'free';
  const [listed, setListed] = useState<{
    user: string;
    joined?: boolean;
    busy: boolean;
    error: string;
  }>();
  const membership = listed?.user === userId ? listed : undefined;

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

  // Pro is a waitlist for now: an account on the Free plan can join it here, as in Togle on a computer.
  const askWaitlist = useCallback(
    async (
      user: string,
      action: 'status' | 'join' | 'leave',
      before?: boolean,
    ) => {
      setListed({ user, joined: before, busy: true, error: '' });
      let joined = before;
      let error = '';
      try {
        joined = await proWaitlist(action);
      } catch (failure) {
        error =
          failure instanceof Error
            ? failure.message
            : 'The Togle Pro waitlist is unavailable. Try again.';
      }
      // Another account may have signed in while the service answered.
      setListed(now =>
        now?.user === user ? { user, joined, busy: false, error } : now,
      );
    },
    [],
  );

  useEffect(() => {
    if (userId && free) askWaitlist(userId, 'status');
  }, [userId, free, askWaitlist]);

  const pro: Waitlist | undefined =
    userId && free
      ? {
          joined: membership?.joined,
          busy: membership?.busy ?? true,
          error: membership?.error ?? '',
          change: () =>
            askWaitlist(
              userId,
              membership?.joined === undefined
                ? 'status'
                : membership.joined
                ? 'leave'
                : 'join',
              membership?.joined,
            ),
        }
      : undefined;

  async function signOut() {
    if (!account || signingOut) return;
    setSigningOut(true);
    setSignOutError('');
    try {
      const result = await account.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
      setShowAccount(false);
      setEntitlement(undefined);
      setListed(undefined);
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
  const openAccount = () => {
    Keyboard.dismiss();
    setSignOutError('');
    setShowAccount(true);
  };
  const page = [s.page, { paddingHorizontal: gutter }];

  return (
    <SafeAreaView style={s.fill}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <View style={[s.header, { paddingHorizontal: gutter }]}>
        <View style={s.topRow}>
          <Image source={logo} style={s.logo} />
          <Text style={s.wordmark}>Togle</Text>
        </View>
        {email && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Togle account"
            accessibilityState={{ expanded: showAccount }}
            onPress={openAccount}
            style={styles.account}
          >
            <View style={[styles.avatar, { backgroundColor: colors.tint }]}>
              <Text style={[s.small, { color: colors.accent }]}>
                {email.slice(0, 2).toUpperCase()}
              </Text>
            </View>
          </Pressable>
        )}
      </View>
      {session === undefined ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : authError ? (
        <View style={page}>
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
                waitlist={pro}
                onAccount={openAccount}
              />
            ) : current?.error ? (
              <View style={page}>
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
              <Text accessibilityRole="header" style={s.h2}>
                Togle account
              </Text>
              <View>
                <View style={styles.fact}>
                  <Text style={s.subtitle}>Email</Text>
                  <Text selectable style={[s.subtitle, s.strong, styles.value]}>
                    {email}
                  </Text>
                </View>
                {current?.plan && (
                  <View style={[styles.fact, s.divider]}>
                    <Text style={s.subtitle}>Plan</Text>
                    <Text style={[s.subtitle, s.strong, styles.value]}>
                      {current.plan === 'free'
                        ? 'Free'
                        : current.plan === 'trial'
                        ? 'Togle Pro trial'
                        : 'Togle Pro'}
                    </Text>
                  </View>
                )}
                {pro && (
                  <View style={[styles.fact, s.divider]}>
                    <Text style={[s.subtitle, s.grow]}>
                      {pro.joined ? 'You’re on the Pro waitlist.' : 'Togle Pro'}
                    </Text>
                    {(pro.joined !== undefined || !!pro.error) && (
                      <Button
                        title={
                          pro.joined === undefined
                            ? 'Try again'
                            : pro.joined
                            ? 'Leave waitlist'
                            : 'Join waitlist'
                        }
                        primary={pro.joined === false}
                        disabled={pro.busy}
                        onPress={pro.change}
                      />
                    )}
                  </View>
                )}
              </View>
              <ErrorMessage message={pro?.error ?? ''} />
              <ErrorMessage message={signOutError} />
              <Button
                title={signingOut ? 'Signing out…' : 'Sign out'}
                disabled={signingOut}
                onPress={signOut}
              />
              <Button
                title="Close"
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
  // A 48 target around the 34 circle of the design.
  account: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fact: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 10,
  },
  value: { flexShrink: 1, textAlign: 'right' },
});
