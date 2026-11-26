import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChatText } from './ChatText';
import { DeliveryTicks } from './icons';
import type { PhoneActivity, PhoneReceipt } from './phone-report';
import { useTheme } from './ui';

export type Answer = {
  request: string;
  question: string;
  choice: string;
  at: number;
  after?: string;
  phase: 'sending' | 'sent' | 'failed';
  error?: string;
};

const clock = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function timeOf(at?: number): string {
  return at && at > 946_684_800_000 ? clock.format(at) : '';
}

export function activityKey(entry: PhoneActivity): string {
  return JSON.stringify([entry.kind, entry.id ?? entry.text]);
}

function splitQuote(message: string) {
  const quoted = /^Replying to “([^”]+)”:? ?([\s\S]*)$/.exec(message.trim());
  const reply = quoted?.[2].trim();
  return quoted && reply ? { quote: quoted[1], reply } : undefined;
}

function placeAnswers(activity: PhoneActivity[], answers: Answer[]) {
  const keys = activity.map(activityKey);
  const before = new Map<number, Answer[]>();
  for (const answer of answers) {
    if (answer.phase === 'failed') continue;
    const anchor = answer.after ? keys.lastIndexOf(answer.after) : -1;
    const matched = activity.some((entry, index) => {
      if (entry.kind !== 'you') return false;
      if (entry.replyTo) return entry.replyTo === answer.request;
      if (index <= anchor) return false;
      const quoted = splitQuote(entry.text);
      return (
        quoted?.quote === answer.question && quoted.reply === answer.choice
      );
    });
    if (matched) continue;
    const later = activity.findIndex(
      entry => entry.at !== undefined && entry.at > answer.at,
    );
    const index =
      anchor >= 0 ? anchor + 1 : later >= 0 ? later : activity.length;
    const group = before.get(index);
    if (group) group.push(answer);
    else before.set(index, [answer]);
  }
  return before;
}

function YouCard({
  text,
  quote,
  at,
  delivery,
}: {
  text: string;
  quote?: string;
  at?: number;
  delivery: PhoneReceipt | 'sending';
}) {
  const { colors, s } = useTheme();
  const time = timeOf(at);
  return (
    <View
      testID="chat-prompt"
      style={[
        styles.prompt,
        {
          backgroundColor: colors.tint,
          borderColor: colors.line,
          borderLeftColor: colors.accent,
        },
      ]}
    >
      <View style={styles.meta}>
        <Text style={[s.label, { color: colors.accent }]}>You</Text>
        {!!time && <Text style={s.secondary}>{time}</Text>}
        <View style={styles.receipt}>
          <DeliveryTicks state={delivery} />
        </View>
      </View>
      {!!quote && (
        <Text
          selectable
          style={[s.secondary, styles.quoted, { borderColor: colors.accent }]}
        >
          {quote}
        </Text>
      )}
      <ChatText text={text} />
    </View>
  );
}

function Message({ entry }: { entry: PhoneActivity }) {
  const { colors, s } = useTheme();
  if (entry.kind === 'you') {
    const quoted = splitQuote(entry.text);
    return (
      <YouCard
        text={quoted?.reply ?? entry.text}
        quote={quoted?.quote}
        at={entry.at}
        delivery={entry.delivery ?? 'sent'}
      />
    );
  }
  if (entry.kind === 'work') {
    return (
      <View
        testID="chat-work"
        style={[styles.work, { borderColor: colors.line }]}
      >
        <Text style={s.secondary}>{entry.text}</Text>
      </View>
    );
  }
  const time = timeOf(entry.at);
  return (
    <View testID="chat-agent" style={styles.reply}>
      <ChatText text={entry.text} />
      {!!time && <Text style={s.secondary}>{time}</Text>}
    </View>
  );
}

export function ChatThread({
  activity,
  answers,
}: {
  activity: PhoneActivity[];
  answers: Answer[];
}) {
  const receipts = useMemo(
    () => placeAnswers(activity, answers),
    [activity, answers],
  );
  const renderAnswers = (position: number) =>
    receipts
      .get(position)
      ?.map(answer => (
        <YouCard
          key={answer.request}
          text={answer.choice}
          quote={answer.question}
          at={answer.at}
          delivery={answer.phase === 'sending' ? 'sending' : 'sent'}
        />
      ));
  return (
    <>
      {activity.map((entry, index) => (
        <React.Fragment
          key={entry.id === undefined ? index : activityKey(entry)}
        >
          {renderAnswers(index)}
          <Message entry={entry} />
        </React.Fragment>
      ))}
      {renderAnswers(activity.length)}
    </>
  );
}

const styles = StyleSheet.create({
  prompt: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 10,
    gap: 6,
    padding: 11,
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  receipt: { marginLeft: 'auto' },
  quoted: { paddingLeft: 9, borderLeftWidth: 2 },
  reply: { gap: 5, paddingHorizontal: 2 },
  work: {
    borderLeftWidth: 2,
    paddingLeft: 10,
    paddingVertical: 2,
    marginLeft: 2,
  },
});
