import React, { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import type { Device } from './device-client';
import type { PhoneQuery, PhoneReport, PhoneUsage } from './phone-report';
import { useTheme } from './ui';

export type LoadReport = (
  device: string,
  query: PhoneQuery,
) => Promise<PhoneReport>;

/** Where the reading of a report stands: the computer shares none, it is on its way, it is here, or it could not be read. */
export type ReportStatus = 'off' | 'loading' | 'ready' | 'failed';

/**
 * A computer's report, read again while it is looked at. A computer that stops sharing has its report taken off the
 * screen at once. One that only goes offline keeps the last report on the screen: nothing newer can be read until it
 * is back, and what was read is not lost under the reader's eyes.
 */
export function usePhoneReportState(
  host: Device,
  active: boolean,
  load: LoadReport,
  session?: string,
  revision?: string,
) {
  const [report, setReport] = useState<PhoneReport>();
  const [failed, setFailed] = useState(false);
  const refreshRef = useRef<() => void>(undefined);
  const previous = useRef(revision);
  const share = host.online && host.phoneReports === true;
  const revoked = host.online && host.phoneReports !== true;
  const device = host.device;
  useEffect(() => {
    if (!revoked) return;
    setReport(undefined);
    setFailed(false);
  }, [revoked]);
  useEffect(() => {
    if (!share || !active) return;

    const query: PhoneQuery = session
      ? { kind: 'session', task: session, view: 'chat' }
      : { kind: 'usage' };
    let viewing = true;
    let pending = false;
    let reread = false;
    const refresh = () => {
      if (
        !viewing ||
        AppState.currentState === 'background' ||
        AppState.currentState === 'inactive'
      )
        return;
      if (pending) {
        reread = true;
        return;
      }
      pending = true;
      reread = false;
      load(device, query)
        .then(value => {
          if (!viewing) return;
          setReport(value);
          setFailed(false);
        })
        .catch(() => {
          if (viewing) setFailed(true);
        })
        .finally(() => {
          pending = false;
          if (reread) refresh();
        });
    };
    refreshRef.current = refresh;
    refresh();
    // A conversation is read again each minute, account limits every three.
    const timer = setInterval(refresh, session ? 60_000 : 180_000);
    const appState = AppState.addEventListener('change', next => {
      if (next === 'active') refresh();
    });
    return () => {
      viewing = false;
      refreshRef.current = undefined;
      clearInterval(timer);
      appState.remove();
    };
  }, [active, device, load, session, share]);
  useEffect(() => {
    if (previous.current === revision) return;
    previous.current = revision;
    refreshRef.current?.();
  }, [revision]);
  const shown = revoked ? undefined : report;
  const status: ReportStatus = shown
    ? 'ready'
    : !share
    ? 'off'
    : failed
    ? 'failed'
    : 'loading';
  return { report: shown, status, retry: () => refreshRef.current?.() };
}

export function usePhoneReport(
  host: Device,
  active: boolean,
  load: LoadReport,
  session?: string,
  revision?: string,
) {
  return usePhoneReportState(host, active, load, session, revision).report;
}

function resetCountdown(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return 'reset due';
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `resets in ${days}d ${hours % 24}h`;
  if (hours) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

export function UsageReadings({
  readings,
  end,
}: {
  readings?: string[];
  end?: boolean;
}) {
  const { s } = useTheme();
  return (
    <View style={[styles.readings, end && styles.end]}>
      {(readings?.length ? readings : ['Not reported']).map((line, index) => (
        <Text key={index} selectable style={[s.meta, end && styles.endText]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

export function AccountLimits({ limits }: { limits: PhoneUsage['limits'] }) {
  const { s } = useTheme();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={styles.readings}>
      {limits.map((limit, index) => (
        <Text key={index} style={s.meta}>
          {limit.label}{' '}
          <Text style={s.strong}>{Math.round(limit.usedPercent)}% used</Text>
          {limit.resetsAt ? ` · ${resetCountdown(limit.resetsAt, now)}` : ''}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  readings: { gap: 3 },
  end: { alignItems: 'flex-end' },
  endText: { textAlign: 'right' },
});
