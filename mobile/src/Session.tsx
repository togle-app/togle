import React, { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
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
  usePhoneReport,
  type LoadReport,
} from './ReportUsage';
import { Button, ErrorMessage, useTheme } from './ui';

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
  const ring = state === 'idle' || state === 'working';
  return (
    <View style={[styles.pill, { backgroundColor: fill }]}>
      <View
        style={[
          ring ? styles.ring : styles.dot,
          ring ? { borderColor: ink } : { backgroundColor: ink },
          state === 'working' && styles.openRing,
        ]}
      />
      <Text style={[s.label, { color: ink }]}>{statuses[state]}</Text>
    </View>
  );
}

function SessionHeader({
  host,
  task,
  title,
  agent,
  details,
  onBack,
}: {
  host: Device;
  task?: Task;
  title: string;
  agent: string;
  details?: PhoneSessionReport;
  onBack(): void;
}) {
  const { s, colors } = useTheme();
  const model = details?.model;
  const limits = details?.usage.limits;
  return (
    <View
      style={[
        styles.headerBand,
        { borderColor: colors.line, backgroundColor: colors.surface },
      ]}
    >
      <View style={[styles.inner, styles.header]}>
        <View style={styles.breadcrumb}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to Agents"
            onPress={onBack}
            style={styles.back}
          >
            <Icon name="left" color={colors.accent} />
            <Text style={[s.label, { color: colors.accent }]}>Agents</Text>
          </Pressable>
          <Text numberOfLines={1} style={[s.secondary, s.grow]}>
            {host.name}
            {task?.folder ? ' / ' + task.folder : ''}
          </Text>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={[s.h1, styles.title]}
        >
          {title}
        </Text>
        <View style={s.actions}>
          {task && <StatusPill state={task.state} />}
          <View style={styles.identity}>
            <AgentMark agent={agent} size={24} />
            <Text style={[s.label, styles.agentName]}>
              {agent}
              {!!model && <Text style={s.secondary}>{' · ' + model}</Text>}
            </Text>
          </View>
        </View>
        {task && (
          <View style={styles.usage}>
            <View style={styles.usageRow}>
              <View style={[s.topRow, styles.usageLabel]}>
                <Icon name="usage" color={colors.muted} size={17} />
                <Text style={[s.label, styles.wrapping]}>This session</Text>
              </View>
              <View style={s.grow}>
                <UsageReadings readings={details?.usage.readings} />
              </View>
            </View>
            {!!limits?.length && (
              <View style={styles.usageRow}>
                <View style={[s.topRow, styles.usageLabel]}>
                  <Icon name="clock" color={colors.muted} size={17} />
                  <Text style={[s.label, styles.wrapping]}>Account limits</Text>
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
  const { height, fontScale } = useWindowDimensions();
  const fixedHeader = height >= 620 && fontScale <= 1.35;
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
  const displayName = agentName(task?.agent ?? agent);
  const report = usePhoneReport(
    host,
    active && !!task,
    loadReport,
    task?.key,
    task && `${task.state}:${task.updatedAt ?? 0}:${activityRevision}`,
  );
  const details =
    task && report?.kind === 'session' && report.task === task.key
      ? report
      : undefined;
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
      onBack={onBack}
    />
  );
  const error =
    currentAnswer?.error ?? (!pending ? answers.at(-1)?.error : undefined);
  const displayedAnswer = answers.some(answer => answer.phase !== 'failed');

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
    <KeyboardAvoidingView
      style={s.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
            style={[styles.inner, styles.thread]}
            testID="session-conversation"
          >
            {!activity.length && !!task?.line && (
              <Text selectable style={s.text}>
                {task.line}
              </Text>
            )}
            <ChatThread activity={activity} answers={answers} />
            {pending ? (
              <View
                testID="chat-question"
                style={[
                  styles.question,
                  { borderColor: colors.wait, backgroundColor: colors.amber },
                ]}
              >
                <Text style={[s.label, { color: colors.wait }]}>
                  {displayName} asks
                </Text>
                <Text selectable style={s.text}>
                  {pending.question}
                </Text>
                {canReply ? (
                  <View style={s.actions}>
                    {pending.choices?.map((choice, index) => (
                      <Button
                        key={index}
                        title={choice}
                        testID={'answer-choice-' + index}
                        style={styles.choice}
                        onPress={() =>
                          onReply(
                            index,
                            lastEntry ? activityKey(lastEntry) : undefined,
                          )
                        }
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={s.secondary}>Continue on {host.name}.</Text>
                )}
                <ErrorMessage message={error ?? ''} />
              </View>
            ) : (
              <>
                {!host.online && (
                  <Text style={s.secondary}>{host.name} is offline.</Text>
                )}
                {host.online && !task && !displayedAnswer && (
                  <Text style={s.secondary}>
                    This session is no longer shared.
                  </Text>
                )}
                {host.online && task?.state === 'waiting' && !currentAnswer && (
                  <Text style={s.secondary}>Continue on {host.name}.</Text>
                )}
                {host.online &&
                  task &&
                  task.state !== 'waiting' &&
                  !activity.length &&
                  !task.line &&
                  !displayedAnswer && (
                    <Text style={s.secondary}>
                      No messages shared for this session.
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
          onSend={sendDraft}
          onChange={reviseDraft}
          stop={task?.canStop ? () => runChat({ what: 'stop' }) : undefined}
        />
      ) : host.online &&
        task &&
        (task.state !== 'waiting' || (pending && canReply)) ? (
        <View style={[s.divider, { backgroundColor: colors.surface }]}>
          <Text style={[s.secondary, styles.inner, styles.replyPlace]}>
            Reply on {host.name}.
          </Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  inner: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 704,
    paddingHorizontal: 16,
  },
  headerBand: { borderBottomWidth: 1 },
  header: { paddingTop: 3, paddingBottom: 12, gap: 8 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  back: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { fontSize: 24 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  agentName: { flexShrink: 1 },
  usage: { gap: 5, marginTop: 2 },
  usageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  usageLabel: { width: 130, minHeight: 19 },
  wrapping: { flexShrink: 1 },
  thread: { paddingTop: 13, paddingBottom: 16, gap: 13 },
  question: { borderWidth: 1, borderRadius: 10, padding: 11, gap: 9 },
  choice: { flexGrow: 1, minWidth: 72 },
  replyPlace: { paddingVertical: 10 },
  latest: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 13,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 18,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  ring: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  openRing: { borderRightColor: 'transparent' },
});
