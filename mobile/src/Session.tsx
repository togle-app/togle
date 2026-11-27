import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  ChatDock,
  ChatQueue,
  EMPTY_DRAFT,
  ReplyNotice,
  type ChatDraft,
  type ChangeDraft,
} from './ChatDock';
import { activityKey, ChatThread, type Answer } from './ChatThread';
import type { Device, PhoneChatAction, Request, Task } from './device-client';
import { AgentMark, agentName, Icon } from './icons';
import type {
  PhoneActivity,
  PhoneDelivery,
  PhoneSessionReport,
} from './phone-report';
import {
  AccountLimits,
  UsageReadings,
  usePhoneReportState,
  type LoadReport,
} from './ReportUsage';
import { Button, ErrorMessage, useKeyboardSpace, useTheme } from './ui';

const statuses: Record<Task['state'], string> = {
  waiting: 'Waiting',
  working: 'Working',
  stopped: 'Stopped',
  idle: 'Idle',
  failed: 'Failed',
};

export function StatusPill({ state }: { state: Task['state'] }) {
  const { colors, s } = useTheme();
  const palette = {
    waiting: [colors.wait, colors.amber],
    working: [colors.accent, colors.tint],
    idle: [colors.good, colors.green],
    stopped: [colors.muted, colors.raised],
    failed: [colors.danger, colors.dangerSoft],
  };
  const [ink, fill] = palette[state];
  // Waiting is a dot, Idle a ring, Working a ring open on one side. Each side of the open ring is named, so that no
  // colour for the whole edge can close it again.
  const mark =
    state === 'working'
      ? [
          styles.ring,
          styles.openRing,
          {
            borderTopColor: ink,
            borderBottomColor: ink,
            borderLeftColor: ink,
          },
        ]
      : state === 'idle'
      ? [styles.ring, { borderColor: ink }]
      : [{ backgroundColor: ink }, state === 'stopped' && styles.square];
  return (
    <View style={[styles.pill, { backgroundColor: fill }]}>
      <View style={[styles.dot, mark]} />
      <Text style={[s.tiny, { color: ink }]}>{statuses[state]}</Text>
    </View>
  );
}

function SessionHeader({
  host,
  task,
  title,
  agent,
  details,
  side,
  onBack,
}: {
  host: Device;
  task?: Task;
  title: string;
  agent: string;
  details?: PhoneSessionReport;
  side: number;
  onBack(): void;
}) {
  const { s, colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const model = details?.model;
  const limits = details?.usage.limits;
  // Both captions take the room of the longer one, so the readings line up.
  const caption = { width: Math.round(104 * Math.min(fontScale, 1.6)) };
  return (
    <View style={[styles.headerBand, { borderColor: colors.line }]}>
      <View style={[styles.header, { paddingHorizontal: side }]}>
        <View style={styles.breadcrumb}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to Agents"
            onPress={onBack}
            style={styles.back}
          >
            <Icon name="left" color={colors.accent} size={19} />
            <Text style={[s.label, { color: colors.accent }]}>Agents</Text>
          </Pressable>
          <Text numberOfLines={1} style={[s.meta, s.grow]}>
            {host.name}
            {task?.folder ? '  /  ' + task.folder : ''}
          </Text>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={[s.h1, styles.title]}
        >
          {title}
        </Text>
        <View testID="session-identity" style={styles.identity}>
          {task && <StatusPill state={task.state} />}
          <View style={styles.agent}>
            <AgentMark agent={agent} size={19} bare />
            <Text style={[s.small, { color: colors.ink }]}>{agent}</Text>
          </View>
          {!!model && <Text style={[s.meta, styles.model]}>{model}</Text>}
        </View>
        {!host.online && (
          <Text style={[s.meta, styles.offline]}>
            {host.name + ' is offline.'}
          </Text>
        )}
        {task && (
          <View style={styles.usage}>
            <View style={styles.usageRow}>
              <View style={[styles.usageLabel, caption]}>
                <Icon name="usage" color={colors.muted} size={14} />
                <Text style={[s.small, styles.wrapping]}>This session</Text>
              </View>
              <View style={s.grow}>
                <UsageReadings readings={details?.usage.readings} />
              </View>
            </View>
            {!!limits?.length && (
              <View style={styles.usageRow}>
                <View style={[styles.usageLabel, caption]}>
                  <Icon name="clock" color={colors.muted} size={14} />
                  <Text style={[s.small, styles.wrapping]}>Account limits</Text>
                </View>
                <View style={s.grow}>
                  <AccountLimits limits={limits} />
                </View>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const EMPTY_ACTIVITY: PhoneActivity[] = [];

function messageId() {
  const random = (
    globalThis as typeof globalThis & {
      crypto: { getRandomValues(bytes: Uint8Array): Uint8Array };
    }
  ).crypto;
  return Array.from(random.getRandomValues(new Uint8Array(12)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function Session({
  host,
  task,
  sessionKey,
  title,
  agent,
  request,
  answers,
  canReply,
  active,
  loadReport,
  onBack,
  onReply,
  draft = EMPTY_DRAFT,
  changeDraft,
  onChat,
}: {
  host: Device;
  task: Task | undefined;
  /** The session's key, known also while its computer is offline and lists no session. */
  sessionKey?: string;
  title: string;
  agent: string;
  request: Request | undefined;
  answers: Answer[];
  canReply: boolean;
  active: boolean;
  loadReport: LoadReport;
  onBack(): void;
  onReply(choice: number, after?: string): void;
  draft?: ChatDraft;
  changeDraft?: ChangeDraft;
  onChat?(action: PhoneChatAction): Promise<PhoneDelivery | undefined>;
}) {
  const { s, colors } = useTheme();
  const keyboard = useKeyboardSpace();
  const { width, height, fontScale } = useWindowDimensions();
  const fixedHeader = height >= 620 && fontScale <= 1.35;
  // The conversation keeps 14 beside it on a phone and up to 26 on a tablet, where it is a column with an edge each side.
  const side = Math.round(Math.min(26, Math.max(14, width * 0.03)));
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const followsLatest = useRef(true);
  const [away, setAway] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [activityRevision, setActivityRevision] = useState(0);
  const sending = useRef(false);
  const canSend =
    !!onChat && !!changeDraft && canReply && task?.canSend === true;
  const currentAnswer = answers.find(answer => answer.request === request?.id);
  const pending =
    host.online &&
    request &&
    (!currentAnswer || currentAnswer.phase === 'failed')
      ? request
      : undefined;
  // The agent waits for something this phone was not given: the answer is made on its computer.
  const handBack =
    host.online && task?.state === 'waiting' && !pending && !currentAnswer;
  const stopInCard = handBack && canSend && task?.canStop === true;
  const displayName = agentName(task?.agent ?? agent);
  const deviceIcon = host.role === 'server' ? 'server' : 'laptop';
  const key = task?.key ?? sessionKey;
  const { report, status, retry } = usePhoneReportState(
    host,
    active && !!task,
    loadReport,
    key,
    task && `${task.state}:${task.updatedAt ?? 0}:${activityRevision}`,
  );
  // What was read stays while the computer is offline. A session an online computer no longer lists is not shown.
  const details =
    (task || !host.online) && report?.kind === 'session' && report.task === key
      ? report
      : undefined;
  const loading = !!task && status === 'loading';
  const unread = !!task && status === 'failed';
  const activity = details?.activity ?? EMPTY_ACTIVITY;
  const queue = details?.queue;
  const lastEntry = activity.at(-1);
  const header = (
    <SessionHeader
      host={host}
      task={task}
      title={task?.title ?? title}
      agent={displayName}
      details={details}
      side={side}
      onBack={onBack}
    />
  );
  const error =
    currentAnswer?.error ?? (!pending ? answers.at(-1)?.error : undefined);
  const displayedAnswer = answers.some(answer => answer.phase !== 'failed');
  const card = [
    styles.question,
    {
      borderColor: colors.line,
      borderLeftColor: colors.wait,
      backgroundColor: colors.surface,
    },
  ];

  function trackPosition({
    nativeEvent,
  }: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentSize, layoutMeasurement, contentOffset } = nativeEvent;
    const following =
      contentSize.height - layoutMeasurement.height - contentOffset.y < 64;
    if (following === followsLatest.current) return;
    followsLatest.current = following;
    setAway(!following);
  }

  // "Message sent" is a passing word: the message itself is in the conversation, with its ticks.
  useEffect(() => {
    if (!feedback || feedback === 'Sending…') return;
    const timer = setTimeout(() => setFeedback(''), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  function latest() {
    followsLatest.current = true;
    setAway(false);
    scroll.current?.scrollToEnd({ animated: true });
  }

  async function runChat(action: PhoneChatAction) {
    if (!canSend || !onChat || sending.current) return false;
    sending.current = true;
    setActionBusy(true);
    setActionError('');
    setFeedback(action.what === 'send-message' ? 'Sending…' : '');
    try {
      const delivery = await onChat(action);
      setFeedback(
        delivery === 'queued'
          ? `Message queued on ${host.name}`
          : delivery === 'sent'
          ? 'Message sent'
          : '',
      );
      return true;
    } catch (failure) {
      setFeedback('');
      setActionError(
        failure instanceof Error
          ? failure.message
          : 'The computer did not confirm the action.',
      );
      return false;
    } finally {
      setActivityRevision(value => value + 1);
      sending.current = false;
      setActionBusy(false);
    }
  }

  async function sendDraft() {
    const text = draft.text.trim();
    if (!canSend || !changeDraft || !text || sending.current) return;
    const id = draft.sendingId ?? messageId();
    changeDraft(previous => ({ ...previous, sendingId: id }));
    latest();
    if (await runChat({ what: 'send-message', id, text })) {
      changeDraft(previous =>
        previous.sendingId === id ? EMPTY_DRAFT : previous,
      );
    }
  }

  function reviseDraft(text: string) {
    setFeedback('');
    setActionError('');
    changeDraft?.(() => ({ text }));
  }

  return (
    <View
      ref={keyboard.ref}
      onLayout={keyboard.onLayout}
      style={[s.fill, { paddingBottom: keyboard.space }]}
    >
      <View
        style={[
          styles.screen,
          { backgroundColor: colors.surface, borderColor: colors.line },
          width > 800 && styles.column,
        ]}
      >
        {fixedHeader && header}
        <View style={s.grow}>
          <ScrollView
            ref={scroll}
            style={s.grow}
            onScroll={trackPosition}
            scrollEventThrottle={32}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            onLayout={() => {
              if (active && followsLatest.current)
                scroll.current?.scrollToEnd({ animated: false });
            }}
            onContentSizeChange={() => {
              if (active && followsLatest.current)
                scroll.current?.scrollToEnd({ animated: false });
            }}
          >
            {!fixedHeader && header}
            <View
              style={[styles.thread, { paddingHorizontal: side }]}
              testID="session-conversation"
            >
              {!activity.length && !!task?.line && (
                <Text selectable style={s.message}>
                  {task.line}
                </Text>
              )}
              <ChatThread
                activity={activity}
                answers={answers}
                agent={displayName}
              />
              {pending ? (
                <View testID="chat-question" style={card}>
                  <Text
                    accessibilityRole="header"
                    selectable
                    style={[s.h2, styles.questionTitle]}
                  >
                    {pending.question}
                  </Text>
                  {canReply ? (
                    <View style={styles.choices}>
                      {pending.choices?.map((choice, index) => (
                        <Pressable
                          key={index}
                          accessibilityRole="button"
                          testID={'answer-choice-' + index}
                          onPress={() =>
                            onReply(
                              index,
                              lastEntry ? activityKey(lastEntry) : undefined,
                            )
                          }
                          style={({ pressed }) => [
                            s.button,
                            styles.choice,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text style={[s.buttonText, styles.choiceText]}>
                            {choice}
                          </Text>
                          <Icon name="right" color={colors.ink} size={19} />
                        </Pressable>
                      ))}
                    </View>
                  ) : (
                    <Text style={s.secondary}>
                      {'Continue on ' + host.name}
                    </Text>
                  )}
                  <ErrorMessage message={error ?? ''} />
                </View>
              ) : (
                <>
                  {host.online && !task && !displayedAnswer && (
                    <Text
                      style={[
                        s.secondary,
                        styles.note,
                        { backgroundColor: colors.raised },
                      ]}
                    >
                      This session is no longer shared.
                    </Text>
                  )}
                  {!host.online && !activity.length && !displayedAnswer && (
                    <Text
                      style={[
                        s.secondary,
                        styles.note,
                        { backgroundColor: colors.raised },
                      ]}
                    >
                      No conversation was saved on this phone before the device
                      went offline.
                    </Text>
                  )}
                  {loading && (
                    <ActivityIndicator
                      color={colors.accent}
                      accessibilityLabel="Loading the conversation"
                      style={styles.loading}
                    />
                  )}
                  {unread && (
                    <View
                      style={[
                        styles.note,
                        styles.unread,
                        { backgroundColor: colors.raised },
                      ]}
                    >
                      <Text style={[s.secondary, s.grow]}>
                        Could not load the conversation.
                      </Text>
                      <Button title="Try again" link onPress={retry} />
                    </View>
                  )}
                  {handBack && (
                    <View testID="session-hand-back" style={card}>
                      <Text
                        accessibilityRole="header"
                        style={[s.h2, styles.questionTitle]}
                      >
                        {'Continue on ' + host.name}
                      </Text>
                      <Text style={s.secondary}>
                        {displayName + ' is waiting for an answer there.'}
                      </Text>
                      {stopInCard && (
                        <Button
                          title="Stop task"
                          danger
                          disabled={actionBusy}
                          style={styles.stopTask}
                          onPress={() => runChat({ what: 'stop' })}
                        />
                      )}
                    </View>
                  )}
                  {host.online &&
                    task &&
                    task.state !== 'waiting' &&
                    !loading &&
                    !unread &&
                    !activity.length &&
                    !task.line &&
                    !displayedAnswer && (
                      <Text
                        style={[
                          s.secondary,
                          styles.note,
                          { backgroundColor: colors.raised },
                        ]}
                      >
                        This agent hasn’t shared messages from this session.
                      </Text>
                    )}
                  <ErrorMessage message={error ?? ''} />
                </>
              )}
              {!!queue?.messages.length && (
                <ChatQueue
                  queue={queue}
                  host={host.name}
                  busy={actionBusy}
                  onSend={
                    canSend
                      ? () =>
                          runChat({
                            what: 'manage-queue',
                            revision: queue.revision,
                            action: 'send',
                          })
                      : undefined
                  }
                  onRemove={
                    canSend
                      ? index =>
                          runChat({
                            what: 'manage-queue',
                            revision: queue.revision,
                            action: 'remove',
                            index,
                          })
                      : undefined
                  }
                />
              )}
            </View>
          </ScrollView>
          {away && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to the latest"
              onPress={latest}
              style={[
                styles.latest,
                { backgroundColor: colors.surface, borderColor: colors.line },
              ]}
            >
              <Icon name="down" color={colors.accent} size={14} />
              <Text style={[s.label, { color: colors.accent }]}>Latest</Text>
            </Pressable>
          )}
        </View>
        {canSend ? (
          <ChatDock
            agent={displayName}
            draft={draft}
            waiting={task?.state === 'waiting'}
            busy={actionBusy}
            status={feedback}
            error={actionError}
            side={side}
            onSend={sendDraft}
            onChange={reviseDraft}
            stop={
              task?.canStop && !stopInCard
                ? () => runChat({ what: 'stop' })
                : undefined
            }
          />
        ) : !host.online ? (
          <ReplyNotice
            icon={deviceIcon}
            title="Sending unavailable"
            detail={`${host.name} is offline.`}
            side={side}
          />
        ) : !task ? null : !canReply ? (
          <ReplyNotice
            icon="lock"
            title="Phone replies are off"
            detail={`Allow replies for this phone in Togle on ${host.name}.`}
            side={side}
          />
        ) : handBack ? null : (
          <ReplyNotice
            icon={deviceIcon}
            title={`Reply on ${host.name}`}
            side={side}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, width: '100%', maxWidth: 820, alignSelf: 'center' },
  column: { borderLeftWidth: 1, borderRightWidth: 1 },
  headerBand: { borderBottomWidth: 1 },
  header: { paddingBottom: 10 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 23, letterSpacing: -0.8 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 5,
    marginTop: 7,
  },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  model: { flexShrink: 1 },
  offline: { marginTop: 6 },
  usage: { gap: 3, marginTop: 5 },
  usageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 3,
  },
  usageLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  wrapping: { flexShrink: 1 },
  thread: { paddingTop: 8, paddingBottom: 12 },
  question: {
    marginTop: 14,
    marginBottom: 6,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingHorizontal: 17,
    paddingTop: 17,
    paddingBottom: 16,
    gap: 10,
  },
  questionTitle: { fontSize: 16, letterSpacing: -0.4 },
  choices: { gap: 12 },
  choice: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  choiceText: { flexShrink: 1, textAlign: 'left' },
  pressed: { opacity: 0.72 },
  stopTask: { alignSelf: 'flex-start', marginTop: 2 },
  loading: { marginTop: 18 },
  unread: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  note: {
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    overflow: 'hidden',
  },
  latest: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 15,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  ring: { borderWidth: 1.5 },
  openRing: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderRightColor: 'transparent',
  },
  square: { borderRadius: 1 },
});
