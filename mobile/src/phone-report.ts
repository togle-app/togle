/** Read-only reports inside the encrypted channel between paired devices. */
export type PhoneQuery =
  | { kind: 'session'; task: string; view?: 'chat' }
  | { kind: 'usage' };

export type PhoneActivity = {
  kind: 'you' | 'agent' | 'work';
  text: string;
  id?: number;
  at?: number;
  replyTo?: string;
  delivery?: PhoneReceipt;
};

export type PhoneUsage = {
  readings: string[];
  limits: { label: string; usedPercent: number; resetsAt?: number }[];
};

export type PhoneDelivery = 'sent' | 'queued';
export type PhoneReceipt = 'sent' | 'delivered';

export type PhoneQueue = {
  revision: string;
  messages: string[];
  canSend: boolean;
  note?: string;
};

export type PhoneSessionReport = {
  kind: 'session';
  task: string;
  model?: string;
  activity: PhoneActivity[];
  usage: PhoneUsage;
  queue?: PhoneQueue;
};

export type PhoneUsageReport = {
  kind: 'usage';
  agents: { runner: string; name: string; usage: PhoneUsage }[];
};

export type PhoneReport = PhoneSessionReport | PhoneUsageReport;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function usage(value: unknown): value is PhoneUsage {
  if (
    !record(value) ||
    !Array.isArray(value.readings) ||
    !Array.isArray(value.limits)
  )
    return false;
  return (
    value.readings.length <= 24 &&
    value.readings.every(line => text(line, 180)) &&
    value.limits.length <= 12 &&
    value.limits.every(
      limit =>
        record(limit) &&
        text(limit.label, 80) &&
        typeof limit.usedPercent === 'number' &&
        Number.isFinite(limit.usedPercent) &&
        limit.usedPercent >= 0 &&
        (limit.resetsAt === undefined ||
          (typeof limit.resetsAt === 'number' &&
            Number.isFinite(limit.resetsAt) &&
            limit.resetsAt > 0)),
    )
  );
}

function queue(value: unknown): value is PhoneQueue {
  return (
    record(value) &&
    typeof value.revision === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.revision) &&
    typeof value.canSend === 'boolean' &&
    Array.isArray(value.messages) &&
    value.messages.length <= 20 &&
    value.messages.every(message => text(message, 320)) &&
    (value.note === undefined ||
      (typeof value.note === 'string' && value.note.length <= 220))
  );
}

export function isPhoneReport(
  value: unknown,
  query: PhoneQuery,
): value is PhoneReport {
  if (!record(value) || value.kind !== query.kind) return false;
  if (query.kind === 'usage') {
    return (
      Array.isArray(value.agents) &&
      value.agents.length <= 20 &&
      value.agents.every(
        agent =>
          record(agent) &&
          text(agent.runner, 80) &&
          text(agent.name, 80) &&
          usage(agent.usage),
      )
    );
  }
  return (
    value.task === query.task &&
    (value.model === undefined || text(value.model, 140)) &&
    (value.queue === undefined || queue(value.queue)) &&
    usage(value.usage) &&
    Array.isArray(value.activity) &&
    value.activity.length <= 24 &&
    value.activity.every(
      entry =>
        record(entry) &&
        (entry.kind === 'you' ||
          entry.kind === 'agent' ||
          entry.kind === 'work') &&
        text(entry.text, query.view === 'chat' ? 6_000 : 800) &&
        (entry.id === undefined || Number.isSafeInteger(entry.id)) &&
        (entry.replyTo === undefined ||
          (entry.kind === 'you' && text(entry.replyTo, 200))) &&
        (entry.delivery === undefined ||
          (entry.kind === 'you' &&
            (entry.delivery === 'sent' || entry.delivery === 'delivered'))) &&
        (entry.at === undefined ||
          (typeof entry.at === 'number' && entry.at > 0 && entry.at < 8.64e15)),
    )
  );
}
