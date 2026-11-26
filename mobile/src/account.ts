import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as Keychain from 'react-native-keychain';
import { config } from './config.generated';
import type { DeviceStore } from './device-client';

const serviceFor = (key: string) => 'app.togle.mobile.v1:' + key;

const storage = {
  async getItem(key: string) {
    const item = await Keychain.getGenericPassword({
      service: serviceFor(key),
    });
    return item ? item.password : null;
  },
  async setItem(key: string, value: string) {
    const saved = await Keychain.setGenericPassword('Togle', value, {
      service: serviceFor(key),
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!saved) throw Error('This phone could not save your Togle account.');
  },
  async removeItem(key: string) {
    await Keychain.resetGenericPassword({ service: serviceFor(key) });
  },
};

export function deviceStore(account: string): DeviceStore {
  const keyFor = (key: string) => 'account:' + account + ':' + key;
  return {
    async read<T>(key: string) {
      const value = await storage.getItem(keyFor(key));
      return value === null ? null : (JSON.parse(value) as T);
    },
    async write(key, value) {
      if (value === null) await storage.removeItem(keyFor(key));
      else await storage.setItem(keyFor(key), JSON.stringify(value));
    },
  };
}

export const account = config.accountUrl
  ? createClient(config.accountUrl, config.publishableKey, {
      auth: {
        storage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : undefined;

export type Plan = 'free' | 'trial' | 'pro';

export async function readPlan(): Promise<Plan> {
  if (!account) throw Error('Togle account sign-in is unavailable.');
  const { data, error } = await account.rpc('my_plan');
  if (error) throw Error('Could not check your Togle plan. Try again.');
  const plan: unknown = Array.isArray(data) ? data[0]?.plan : undefined;
  if (plan === 'free' || plan === 'trial' || plan === 'pro') return plan;
  throw Error('Your Togle plan is unavailable. Try again.');
}

export async function tokenFor(userId: string): Promise<string | undefined> {
  const result = await account?.auth.getSession();
  const session = result?.data.session;
  return session?.user.id === userId ? session.access_token : undefined;
}
