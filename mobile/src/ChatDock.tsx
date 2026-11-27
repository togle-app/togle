import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DeliveryTicks, Icon } from './icons';
import type { PhoneQueue } from './phone-report';
import { Button, ErrorMessage, useTheme } from './ui';

export type ChatDraft = { text: string; sendingId?: string };
export type ChangeDraft = (update: (draft: ChatDraft) => ChatDraft) => void;
export const EMPTY_DRAFT: ChatDraft = { text: '' };

/** The message box under a conversation: Stop while nothing is written, the send arrow once something is. */
export function ChatDock({
  agent,
  draft,
  waiting,
  busy,
  stop,
  status,
  error,
  side = 14,
  onChange,
  onSend,
}: {
  agent: string;
  draft: ChatDraft;
  waiting: boolean;
  busy: boolean;
  stop?: () => void;
  status: string;
  error: string;
  side?: number;
  onChange(value: string): void;
  onSend(): void;
}) {
  const { s, colors } = useTheme();
  const written = !!draft.text.trim();
  return (
    <View style={[s.divider, { backgroundColor: colors.surface }]}>
      <View style={[styles.dock, { paddingHorizontal: side }]}>
        <View
          style={[
            styles.box,
            styles.composer,
            { backgroundColor: colors.bg, borderColor: colors.line },
          ]}
        >
          <TextInput
            accessibilityLabel={`Message ${agent}`}
            testID="chat-message"
            placeholder={waiting ? 'Queue a message' : `Message ${agent}`}
            placeholderTextColor={colors.muted}
            value={draft.text}
            onChangeText={onChange}
            multiline
            maxLength={4_000}
            style={[s.field, styles.input]}
          />
          {stop && !written ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop task"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              hitSlop={4}
              onPress={stop}
              style={[styles.round, { backgroundColor: colors.dangerSoft }]}
            >
              <View
                style={[styles.square, { backgroundColor: colors.danger }]}
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={waiting ? 'Queue message' : 'Send message'}
              accessibilityState={{ disabled: !written || busy }}
              testID="chat-send"
              disabled={!written || busy}
              hitSlop={4}
              onPress={onSend}
              style={[
                styles.round,
                { backgroundColor: colors.ink },
                (!written || busy) && styles.off,
              ]}
            >
              <Icon name="send" color={colors.bg} size={19} />
            </Pressable>
          )}
        </View>
        {!!status && (
          <Text accessibilityLiveRegion="polite" style={s.secondary}>
            {status}
          </Text>
        )}
        <ErrorMessage message={error} />
      </View>
    </View>
  );
}

/** In the message box's place when this phone cannot write to the session: why, and where it can be done. */
export function ReplyNotice({
  icon,
  title,
  detail,
  side = 14,
}: {
  icon: 'laptop' | 'server' | 'lock';
  title: string;
  detail?: string;
  side?: number;
}) {
  const { s, colors } = useTheme();
  return (
    <View style={[s.divider, { backgroundColor: colors.surface }]}>
      <View style={[styles.dock, { paddingHorizontal: side }]}>
        <View
          testID="reply-notice"
          style={[
            styles.box,
            styles.notice,
            { backgroundColor: colors.bg, borderColor: colors.line },
          ]}
        >
          <Icon name={icon} color={colors.muted} size={19} />
          <View style={s.grow}>
            <Text style={s.label}>{title}</Text>
            {!!detail && <Text style={s.meta}>{detail}</Text>}
          </View>
        </View>
      </View>
    </View>
  );
}

export function ChatQueue({
  queue,
  host,
  busy,
  onSend,
  onRemove,
}: {
  queue: PhoneQueue;
  host: string;
  busy: boolean;
  onSend?: () => void;
  onRemove?: (index: number) => void;
}) {
  const { s, colors } = useTheme();
  return (
    <View style={[styles.queue, { borderColor: colors.line }]}>
      <Text accessibilityRole="header" style={[s.h2, styles.queueTitle]}>
        Queued on {host}
      </Text>
      {queue.messages.map((text, index) => (
        <View key={index} style={[s.topRow, s.divider, styles.queueItem]}>
          <Text selectable style={[s.message, s.grow]}>
            {text}
          </Text>
          <DeliveryTicks state="sent" />
          {onRemove && (
            <Button
              title="Remove"
              accessibilityLabel={`Remove queued message ${index + 1}`}
              link
              disabled={busy}
              onPress={() => onRemove(index)}
            />
          )}
        </View>
      ))}
      {!!queue.note && <Text style={s.secondary}>{queue.note}</Text>}
      {queue.canSend && onSend && (
        <Button title="Send now" onPress={onSend} disabled={busy} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { paddingVertical: 9, gap: 6 },
  box: {
    minHeight: 56,
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 10,
  },
  composer: {
    alignItems: 'flex-end',
    gap: 6,
    paddingVertical: 5,
    paddingLeft: 12,
    paddingRight: 5,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    maxHeight: 100,
    borderWidth: 0,
    backgroundColor: 'transparent',
    paddingHorizontal: 2,
    paddingVertical: 10,
  },
  round: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  off: { opacity: 0.5 },
  square: { width: 10, height: 10, borderRadius: 1 },
  notice: {
    alignItems: 'center',
    gap: 14,
    paddingVertical: 7,
    paddingHorizontal: 15,
  },
  queue: {
    marginTop: 10,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
  },
  queueTitle: { fontSize: 16, letterSpacing: -0.4 },
  queueItem: { paddingTop: 4 },
});
