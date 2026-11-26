import type { PhoneDelivery, PhoneQuery, PhoneReport } from './phone-report';

export type Request = {
  id: string;
  kind: 'question' | 'command' | 'edit';
  question?: string;
  choices?: string[];
};

export type Task = {
  key: string;
  title: string;
  agent: string;
  folder: string;
  state: 'working' | 'waiting' | 'stopped' | 'idle' | 'failed';
  line: string;
  mine: boolean;
  canSend?: boolean;
  canStop?: boolean;
  updatedAt?: number;
  pending: Request[];
};

export type Device = {
  device: string;
  name: string;
  role: 'computer' | 'server';
  online: boolean;
  canAct: boolean;
  phoneReports?: boolean;
  tasks: Task[];
};

export type PhoneState = {
  standing: 'alone' | 'member' | 'removed';
  link: 'off' | 'connecting' | 'guest' | 'member' | 'refused';
  connection?: 'on' | 'needs-pro' | 'off';
  code?: { code: string; expiresAt: number; joined: boolean; problem?: string };
  invitation?: 'waiting';
  problem?: string;
  devices: Device[];
};

export type DeviceStore = {
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown): Promise<void>;
};

export type PhoneChatAction =
  | { what: 'send-message'; id: string; text: string }
  | {
      what: 'manage-queue';
      revision: string;
      action: 'send' | 'remove';
      index?: number;
    }
  | { what: 'stop' };

export type PhoneClient = {
  ready: Promise<void>;
  pair(): Promise<void>;
  joinInvitation(invitation: string): Promise<void>;
  cancelPair(): void;
  readReport(device: string, query: PhoneQuery): Promise<PhoneReport>;
  chat(
    device: string,
    task: string,
    action: PhoneChatAction,
  ): Promise<PhoneDelivery | undefined>;
  answer(
    device: string,
    task: string,
    request: string,
    choice: number,
  ): Promise<void>;
  close(): void;
};

export function createPhoneClient(options: {
  relay: string;
  name: string;
  email: string;
  accessToken(): Promise<string | undefined>;
  store: DeviceStore;
  onChange(state: PhoneState): void;
}): PhoneClient;
