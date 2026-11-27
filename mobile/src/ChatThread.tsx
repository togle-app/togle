import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChatText } from './ChatText';
import { AgentMark, DeliveryTicks } from './icons';
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
        { backgroundColor: colors.bg, borderColor: colors.line },
      ]}
    >
      <View style={styles.meta}>
        <Text style={s.small}>You</Text>
        {!!time && <Text style={s.meta}>{time}</Text>}
        <View style={styles.receipt}>
          <DeliveryTicks state={delivery} />
        </View>
      </View>
      {!!quote && (
        <Text
          selectable
          style={[s.secondary, styles.quoted, { borderColor: colors.line }]}
        >
          {quote}
        </Text>
      )}
      <ChatText text={text} />
    </View>
  );
}

function Message({ entry, agent }: { entry: PhoneActivity; agent?: string }) {
  const { s } = useTheme();
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
    // The computer sends "2 steps: read 1 file, ran 1 command".
    const steps = /^(\d+ steps?): (.+)$/.exec(entry.text);
    return (
      <View testID="chat-work" style={styles.work}>
        <Text style={s.secondary}>
          {steps ? (
            <>
              <Text style={s.semibold}>{steps[1]}</Text>
              {' · ' + steps[2]}
            </>
          ) : (
            entry.text
          )}
        </Text>
      </View>
    );
  }
  const time = timeOf(entry.at);
  return (
    <View testID="chat-agent" style={styles.reply}>
      {(!!agent || !!time) && (
        <View style={styles.author}>
          {!!agent && <AgentMark agent={agent} size={19} bare />}
          {!!agent && <Text style={s.small}>{agent}</Text>}
          {!!time && <Text style={s.meta}>{time}</Text>}
        </View>
      )}
      <ChatText text={entry.text} />
    </View>
  );
}

/** The conversation, a line between one request of yours and the next. `agent` is the name shown over its replies. */
export function ChatThread({
  activity,
  answers,
  agent,
}: {
  activity: PhoneActivity[];
  answers: Answer[];
  agent?: string;
}) {
  const { s } = useTheme();
  const receipts = useMemo(
    () => placeAnswers(activity, answers),
    [activity, answers],
  );
  const items: { key: string; yours: boolean; node: React.ReactNode }[] = [];
  const addAnswers = (position: number) => {
    for (const answer of receipts.get(position) ?? []) {
      items.push({
        key: 'answer:' + answer.request,
        yours: true,
        node: (
          <YouCard
            text={answer.choice}
            quote={answer.question}
            at={answer.at}
            delivery={answer.phase === 'sending' ? 'sending' : 'sent'}
          />
        ),
      });
    }
  };
  activity.forEach((entry, index) => {
    addAnswers(index);
    items.push({
      key: entry.id === undefined ? 'at:' + index : activityKey(entry),
      yours: entry.kind === 'you',
      node: <Message entry={entry} agent={agent} />,
    });
  });
  addAnswers(activity.length);
  return (
    <>
      {items.map((item, index) => (
        <React.Fragment key={item.key}>
          {item.yours && index > 0 && <View style={[s.divider, styles.turn]} />}
          {item.node}
        </React.Fragment>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  prompt: {
    borderWidth: 1,
    borderRadius: 8,
    gap: 4,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  receipt: { marginLeft: 'auto' },
  quoted: { paddingLeft: 9, borderLeftWidth: 2 },
  reply: { gap: 4, paddingTop: 10, paddingBottom: 5, paddingHorizontal: 2 },
  author: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  work: { paddingTop: 10, paddingHorizontal: 2 },
  turn: { marginVertical: 12 },
});
