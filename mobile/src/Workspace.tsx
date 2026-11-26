import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { deviceStore, tokenFor, type Plan } from './account';
import { Agents } from './Agents';
import { EMPTY_DRAFT, type ChatDraft, type ChangeDraft } from './ChatDock';
import type { Answer } from './ChatThread';
import { config } from './config.generated';
import {
  createPhoneClient,
  type Device,
  type PhoneChatAction,
  type PhoneClient,
  type PhoneState,
  type Task,
} from './device-client';
import { Icon } from './icons';
import type { LoadReport } from './ReportUsage';
import { Session } from './Session';
import { Todo, type WaitingQuestion } from './Todo';
import { Block, Button, ErrorMessage, useTheme } from './ui';

type Tab = 'Agents' | 'To-do';
type PairingAction = 'scan' | 'paste' | 'code';
type Selection = { host: string; task: string; title: string; agent: string };
const sessionKey = (host: string, task: string) => JSON.stringify([host, task]);
const EMPTY_ANSWERS: Answer[] = [];

function questionIn(task: Task) {
  if (!task.mine) return;
  return task.pending.find(
    request =>
      request.kind === 'question' &&
      request.question &&
      request.choices?.length,
  );
}

export function Workspace({
  userId,
  email,
  plan,
}: {
  userId: string;
  email: string;
  plan: Plan;
}) {
  const { s, colors } = useTheme();
  const [tab, setTab] = useState<Tab>('Agents');
  const [phone, setPhone] = useState<PhoneState>();
  const [linkError, setLinkError] = useState('');
  const [retry, setRetry] = useState(0);
  const [showingCode, setShowingCode] = useState(false);
  const [pairingAction, setPairingAction] = useState<PairingAction>();
  const [showPaste, setShowPaste] = useState(false);
  const [invitation, setInvitation] = useState('');
  const [selected, setSelected] = useState<Selection>();
  const [answers, setAnswers] = useState<Record<string, Answer[]>>({});
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
  const inFlight = useRef(new Set<string>());
  const pairingClient = useRef<PhoneClient | null>(null);
  const client = useRef<PhoneClient | null>(null);
  const permitted = plan !== 'free';
  const connected =
    permitted &&
    phone?.standing === 'member' &&
    phone.link === 'member' &&
    phone.connection === 'on';
  const devices = permitted ? phone?.devices ?? [] : [];
  const waiting: WaitingQuestion[] = [];
  if (connected) {
    for (const host of devices) {
      if (!host.canAct) continue;
      for (const task of host.tasks) {
        const needsAnswer = questionIn(task);
        const previous = answers[sessionKey(host.device, task.key)];
        if (
          needsAnswer &&
          !previous?.some(
            answer =>
              answer.phase === 'sent' && answer.request === needsAnswer.id,
          )
        ) {
          waiting.push({ host, task, request: needsAnswer });
        }
      }
    }
  }

  const host =
    selected && devices.find(device => device.device === selected.host);
  const task = host?.tasks.find(item => item.key === selected?.task);
  const request = task && questionIn(task);
  const key = selected && sessionKey(selected.host, selected.task);
  const sessionAnswers = (key && answers[key]) || EMPTY_ANSWERS;
  const activeSession = tab === 'Agents' && !!selected && !!host;
  const canReply = connected && !!host?.canAct;
  const loadReport = useCallback<LoadReport>(async (device, query) => {
    const current = client.current;
    if (!current) throw new Error('The device connection is closed.');
    return current.readReport(device, query);
  }, []);

  useEffect(() => {
    if (!permitted || !config.relay) return;
    setShowingCode(false);
    setPairingAction(undefined);
    setShowPaste(false);
    setInvitation('');
    let active = true;
    const phoneClient = createPhoneClient({
      relay: config.relay,
      name: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
      email,
      accessToken: () => tokenFor(userId),
      store: deviceStore(userId),
      onChange: state => {
        if (!active) return;
        setPhone(state);
        if (state.standing === 'member') {
          setShowingCode(false);
          setInvitation('');
          setShowPaste(false);
        }
        if (state.standing === 'removed') {
          setSelected(undefined);
          setAnswers({});
          setDrafts({});
        }
      },
    });
    client.current = phoneClient;
    phoneClient.ready.catch(() => {
      if (active)
        setLinkError('Could not open the device connection on this phone.');
    });
    return () => {
      active = false;
      client.current = null;
      if (pairingClient.current === phoneClient) pairingClient.current = null;
      phoneClient.close();
    };
  }, [email, userId, permitted, retry]);

  useEffect(() => {
    if (!activeSession) return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelected(undefined);
      return true;
    });
    return () => listener.remove();
  }, [activeSession]);

  function openSession(device: Device, next: Task) {
    Keyboard.dismiss();
    setSelected({
      host: device.device,
      task: next.key,
      title: next.title,
      agent: next.agent,
    });
    setTab('Agents');
  }

  async function startPairing(action: PairingAction) {
    const current = client.current;
    if (!current || showingCode || phone?.invitation || pairingClient.current)
      return;
    pairingClient.current = current;
    setLinkError('');
    setPairingAction(action);
    try {
      if (action === 'code') {
        setInvitation('');
        setShowPaste(false);
        setShowingCode(true);
        await current.pair();
        return;
      }
      let value = invitation;
      setInvitation('');
      if (action === 'scan') {
        try {
          const { DataScanner } =
            require('react-native-data-scanner') as typeof import('react-native-data-scanner');
          const code = await DataScanner.scanBarcode({ targetFormats: ['qr'] });
          value = code.value;
        } catch (failure) {
          if (current !== client.current) return;
          if (
            failure instanceof Error &&
            failure.message.includes('Barcode scan was canceled.')
          )
            return;
          setLinkError(
            'Could not scan with the camera. Paste an invitation or show a pairing code instead.',
          );
          return;
        }
      }
      if (current !== client.current) return;
      Keyboard.dismiss();
      await current.joinInvitation(value);
      if (current === client.current) setShowPaste(false);
    } catch (failure) {
      if (current !== client.current) return;
      setShowingCode(false);
      setLinkError(
        failure instanceof Error
          ? failure.message
          : 'Could not pair this phone. Try again.',
      );
    } finally {
      if (pairingClient.current === current) pairingClient.current = null;
      if (current === client.current) setPairingAction(undefined);
    }
  }

  async function reply(index: number, after?: string) {
    const current = client.current;
    const choice = request?.choices?.[index];
    if (
      !current ||
      !selected ||
      !key ||
      !canReply ||
      !request?.question ||
      choice === undefined ||
      inFlight.current.has(key) ||
      sessionAnswers.some(
        answer => answer.phase === 'sent' && answer.request === request.id,
      )
    )
      return;
    const receipt = {
      request: request.id,
      question: request.question,
      choice,
      at: Date.now(),
      after,
    };
    const record = (value: Answer) => {
      if (current === client.current)
        setAnswers(state => ({
          ...state,
          [key]: [
            ...(state[key] ?? []).filter(
              answer => answer.request !== value.request,
            ),
            value,
          ].slice(-12),
        }));
    };
    inFlight.current.add(key);
    record({ ...receipt, phase: 'sending' });
    try {
      await current.answer(selected.host, selected.task, request.id, index);
      record({ ...receipt, phase: 'sent' });
    } catch (failure) {
      record({
        ...receipt,
        phase: 'failed',
        error:
          failure instanceof Error
            ? failure.message
            : 'The computer did not accept your answer.',
      });
    } finally {
      inFlight.current.delete(key);
    }
  }

  const changeDraft: ChangeDraft = update => {
    if (!key) return;
    setDrafts(values => ({
      ...values,
      [key]: update(values[key] ?? EMPTY_DRAFT),
    }));
  };

  async function chat(action: PhoneChatAction) {
    const current = client.current;
    if (!current || !selected || !canReply || task?.canSend !== true)
      throw new Error('Continue this conversation on its computer.');
    return current.chat(selected.host, selected.task, action);
  }

  const reconnect = () => {
    setPhone(undefined);
    setLinkError('');
    setShowingCode(false);
    setPairingAction(undefined);
    setInvitation('');
    setShowPaste(false);
    setRetry(value => value + 1);
  };
  const notice = !permitted ? (
    <Block>
      <Text style={s.h2}>Connect your devices with Togle Pro</Text>
      <Text style={s.secondary}>
        With Pro, you can pair this phone with your computers and see the agents
        they share.
      </Text>
    </Block>
  ) : !config.relay ? (
    <Block>
      <Text style={s.text}>
        Device connection is unavailable in this build.
      </Text>
    </Block>
  ) : !phone && !linkError ? (
    <ActivityIndicator
      color={colors.accent}
      accessibilityLabel="Opening device connection"
    />
  ) : phone?.standing !== 'member' ? (
    <Block>
      <Text style={s.h2}>
        {phone?.standing === 'removed'
          ? 'Add this phone again'
          : 'Connect this phone'}
      </Text>
      <Text style={s.secondary}>
        On your managing computer, open Togle → Settings → Devices → Add a
        device.
      </Text>
      {phone?.invitation === 'waiting' && (
        <Text style={s.text} accessibilityLiveRegion="polite">
          Approve this phone on your computer.
        </Text>
      )}
      {phone?.code && (
        <>
          <Text
            selectable
            accessibilityLabel={'Pairing code ' + phone.code.code}
            testID="pairing-code"
            style={[s.h1, styles.code, { backgroundColor: colors.tint }]}
          >
            {phone.code.code}
          </Text>
          <Text style={s.text}>
            {phone.code.joined
              ? 'Approve this phone on your computer.'
              : 'Enter this code on your computer.'}
          </Text>
        </>
      )}
      <ErrorMessage
        message={linkError || phone?.code?.problem || phone?.problem || ''}
      />
      {phone?.link === 'refused' || !phone ? (
        <Button title="Try again" onPress={reconnect} />
      ) : showingCode || phone.invitation ? (
        <Button
          title="Cancel pairing"
          disabled={phone.link === 'member'}
          onPress={() => {
            client.current?.cancelPair();
            setShowingCode(false);
            setLinkError('');
          }}
        />
      ) : phone.link === 'member' ? (
        <Button title="Try again" onPress={reconnect} />
      ) : (
        <>
          <Button
            title={
              pairingAction === 'scan' ? 'Opening scanner…' : 'Scan QR code'
            }
            primary
            disabled={!!pairingAction}
            onPress={() => startPairing('scan')}
          />
          {showPaste ? (
            <>
              <TextInput
                accessibilityLabel="Pairing invitation"
                style={s.field}
                value={invitation}
                onChangeText={setInvitation}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                returnKeyType="go"
                maxLength={120}
                secureTextEntry
                onSubmitEditing={() => {
                  if (invitation.trim()) startPairing('paste');
                }}
              />
              <Button
                title="Use invitation"
                onPress={() => startPairing('paste')}
                disabled={!invitation.trim() || !!pairingAction}
              />
            </>
          ) : (
            <Button
              title="Paste invitation"
              disabled={!!pairingAction}
              onPress={() => setShowPaste(true)}
            />
          )}
          <Button
            title="Show pairing code"
            link
            disabled={!!pairingAction}
            onPress={() => startPairing('code')}
          />
        </>
      )}
    </Block>
  ) : !connected ? (
    <Block>
      <Text style={s.text}>
        {phone.connection === 'off'
          ? 'Device connection is switched off for this account.'
          : phone.connection === 'needs-pro'
          ? 'Device connection requires Togle Pro.'
          : phone.link === 'refused'
          ? 'Could not connect this phone.'
          : 'Connecting to your devices…'}
      </Text>
      <ErrorMessage message={linkError || phone.problem || ''} />
      {phone.link === 'refused' && (
        <Button title="Try again" onPress={reconnect} />
      )}
    </Block>
  ) : !devices.length ? (
    <Block>
      <Text style={s.text}>No computers are paired with this phone.</Text>
    </Block>
  ) : null;

  return (
    <View style={s.fill}>
      <View style={s.grow}>
        <Pane active={tab === 'Agents' && !activeSession}>
          <Agents
            devices={devices}
            active={tab === 'Agents' && !activeSession}
            loadReport={loadReport}
            notice={notice}
            onOpen={openSession}
          />
        </Pane>
        <Pane active={tab === 'To-do'}>
          <Todo userId={userId} waiting={waiting} onOpen={openSession} />
        </Pane>
        {selected && host && (
          <Pane key={key} active={activeSession} detail>
            <Session
              host={host}
              task={task}
              title={selected.title}
              agent={selected.agent}
              request={request}
              answers={sessionAnswers}
              canReply={canReply}
              active={activeSession}
              loadReport={loadReport}
              onBack={() => setSelected(undefined)}
              onReply={reply}
              draft={(key && drafts[key]) || EMPTY_DRAFT}
              changeDraft={changeDraft}
              onChat={chat}
            />
          </Pane>
        )}
      </View>
      <View
        accessibilityRole="tablist"
        style={[
          styles.tabs,
          { backgroundColor: colors.surface, borderColor: colors.line },
        ]}
      >
        {(['To-do', 'Agents'] as const).map(name => (
          <Pressable
            key={name}
            accessibilityRole="tab"
            accessibilityLabel={name}
            accessibilityState={{ selected: tab === name }}
            style={styles.tab}
            onPress={() => {
              Keyboard.dismiss();
              if (name === 'Agents' && tab === name) setSelected(undefined);
              setTab(name);
            }}
          >
            <View style={styles.tabIcon}>
              {tab === name && (
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFill,
                    styles.tabHighlight,
                    { backgroundColor: colors.tint },
                  ]}
                />
              )}
              <Icon
                name={name === 'To-do' ? 'todo' : 'agents'}
                color={tab === name ? colors.accent : colors.muted}
              />
            </View>
            <Text
              style={[
                s.label,
                { color: tab === name ? colors.accent : colors.muted },
              ]}
            >
              {name}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// Keep each pane laid out so its scroll offset survives opening a session or switching tabs.
function Pane({
  active,
  detail,
  children,
}: {
  active: boolean;
  detail?: boolean;
  children: React.ReactNode;
}) {
  const { s } = useTheme();
  return (
    <View
      style={[StyleSheet.absoluteFill, !active && styles.hidden]}
      pointerEvents={active ? 'auto' : 'none'}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      {detail ? (
        children
      ) : (
        <ScrollView
          style={s.fill}
          contentContainerStyle={[s.page, styles.page]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { alignSelf: 'center', width: '100%', maxWidth: 704 },
  hidden: { opacity: 0 },
  code: {
    alignSelf: 'flex-start',
    fontSize: 25,
    letterSpacing: 2,
    borderRadius: 8,
    padding: 12,
  },
  tabs: { flexDirection: 'row', borderTopWidth: 1 },
  tab: {
    flex: 1,
    minHeight: 62,
    gap: 3,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  tabIcon: {
    width: 48,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabHighlight: { borderRadius: 14 },
});
