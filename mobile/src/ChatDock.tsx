import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DeliveryTicks } from './icons';
import type { PhoneQueue } from './phone-report';
import { Button, ErrorMessage, useTheme } from './ui';

export type ChatDraft = { text: string; sendingId?: string };
export type ChangeDraft = (update: (draft: ChatDraft) => ChatDraft) => void;
export const EMPTY_DRAFT: ChatDraft = { text: '' };

export function ChatDock({
  agent,
  draft,
  waiting,
  busy,
  stop,
  status,
  error,
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
  onChange(value: string): void;
  onSend(): void;
}) {
  const { s, colors } = useTheme();
  const written = !!draft.text.trim();
  return (
    <View style={[s.divider, { backgroundColor: colors.surface }]}>
      <View style={styles.dock}>
        <View
          style={[
            styles.composer,
            { backgroundColor: colors.raised, borderColor: colors.line },
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
          {!!stop && !written && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop task"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={stop}
              style={[styles.stop, { backgroundColor: colors.dangerSoft }]}
            >
              <View
                style={[styles.square, { backgroundColor: colors.danger }]}
              />
            </Pressable>
          )}
          <Button
            title="Send"
            testID="chat-send"
            accessibilityLabel="Send message"
            primary
            disabled={!written || busy}
            onPress={onSend}
          />
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
  const { s } = useTheme();
  return (
    <View style={s.block}>
      <Text style={s.label}>Queued on {host}</Text>
      {queue.messages.map((text, index) => (
        <View key={index} style={[s.topRow, s.divider, styles.queueItem]}>
          <Text selectable style={[s.text, s.grow]}>
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
  dock: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 704,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    padding: 4,
    borderWidth: 1,
    borderRadius: 12,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    maxHeight: 120,
    borderWidth: 0,
    backgroundColor: 'transparent',
    paddingVertical: 10,
  },
  stop: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
  },
  square: { width: 11, height: 11, borderRadius: 2 },
  queueItem: { paddingTop: 4 },
});
