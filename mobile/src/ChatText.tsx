import React, { memo, useMemo, type ReactNode } from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { decodeHTML } from 'entities';
import { Lexer, type Token, type Tokens } from 'marked';
import { useTheme } from './ui';

function parseChat(text: string) {
  try {
    return Lexer.lex(text, { gfm: true, breaks: true });
  } catch {
    return undefined;
  }
}

function webAddress(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    // File links remain text on the phone.
  }
}

/** Use the desktop's Markdown grammar and render it as selectable native text. */
export const ChatText = memo(function MessageMarkdown({
  text,
}: {
  text: string;
}) {
  const { colors, s } = useTheme();
  const document = useMemo(() => parseChat(text), [text]);
  const border = { borderColor: colors.line };
  const code = [styles.mono, { backgroundColor: colors.raised }];
  const bold = { fontFamily: s.h2.fontFamily };

  function inline(tokens: Token[], depth = 0): ReactNode {
    if (depth > 24) return tokens.map(token => token.raw).join('');
    return tokens.map((token, index) => {
      const words =
        'text' in token && typeof token.text === 'string'
          ? decodeHTML(token.text)
          : token.raw;
      const nested = 'tokens' in token ? token.tokens : undefined;
      const inner = nested?.length ? inline(nested, depth + 1) : words;
      switch (token.type) {
        case 'br':
          return '\n';
        case 'checkbox':
          return token.checked ? '☑ ' : '☐ ';
        case 'strong':
          return (
            <Text key={index} style={bold}>
              {inner}
            </Text>
          );
        case 'em':
          return (
            <Text key={index} style={styles.em}>
              {inner}
            </Text>
          );
        case 'del':
          return (
            <Text key={index} style={styles.strike}>
              {inner}
            </Text>
          );
        case 'codespan':
          return (
            <Text key={index} style={code}>
              {token.text}
            </Text>
          );
        case 'link': {
          const url = webAddress(token.href);
          return url ? (
            <Text
              key={index}
              accessibilityRole="link"
              style={[styles.link, { color: colors.accent }]}
              onPress={() => {
                Linking.openURL(url).catch(() => {});
              }}
            >
              {inner}
            </Text>
          ) : (
            inner
          );
        }
        case 'image':
          return words || 'Picture';
        default:
          return inner;
      }
    });
  }

  function tableRow(cells: Tokens.TableCell[], index: number, header = false) {
    return (
      <View
        key={index}
        style={[
          styles.tableRow,
          border,
          header && { backgroundColor: colors.raised },
        ]}
      >
        {cells.map((cell, position) => (
          <Text
            key={position}
            selectable
            style={[s.text, styles.cell, border, header && bold]}
          >
            {inline(cell.tokens)}
          </Text>
        ))}
      </View>
    );
  }

  function blocks(tokens: Token[], depth = 0): ReactNode {
    if (depth > 24)
      return (
        <Text selectable style={s.text}>
          {tokens.map(token => token.raw).join('')}
        </Text>
      );
    return tokens.map((token, index) => {
      switch (token.type) {
        case 'space':
        case 'def':
          return null;
        case 'hr':
          return <View key={index} style={s.divider} />;
        case 'code':
          return (
            <View key={index} style={[styles.codeBlock, border]}>
              {!!token.lang && (
                <Text
                  numberOfLines={1}
                  style={[
                    s.secondary,
                    styles.codeLanguage,
                    { backgroundColor: colors.raised },
                  ]}
                >
                  {token.lang}
                </Text>
              )}
              <ScrollView horizontal nestedScrollEnabled>
                <Text selectable style={[s.text, styles.mono, styles.codeBody]}>
                  {token.text}
                </Text>
              </ScrollView>
            </View>
          );
        case 'blockquote':
          return (
            <View key={index} style={[styles.blocks, styles.quote, border]}>
              {blocks(token.tokens ?? [], depth + 1)}
            </View>
          );
        case 'list': {
          const list = token as Tokens.List;
          return (
            <View key={index} style={styles.list}>
              {list.items.map((item, position) => (
                <View key={position} style={styles.listItem}>
                  <Text style={s.text}>
                    {list.ordered ? `${Number(list.start) + position}.` : '•'}
                  </Text>
                  <View style={[s.grow, styles.blocks]}>
                    {blocks(item.tokens, depth + 1)}
                  </View>
                </View>
              ))}
            </View>
          );
        }
        case 'table': {
          const table = token as Tokens.Table;
          return (
            <ScrollView
              key={index}
              horizontal
              nestedScrollEnabled
              style={[styles.codeBlock, border]}
            >
              <View>
                {tableRow(table.header, -1, true)}
                {table.rows.map((row, position) => tableRow(row, position))}
              </View>
            </ScrollView>
          );
        }
        case 'heading':
          return (
            <Text
              key={index}
              accessibilityRole="header"
              selectable
              style={s.h2}
            >
              {inline(token.tokens ?? [])}
            </Text>
          );
        default:
          return (
            <Text key={index} selectable style={s.text}>
              {inline([token])}
            </Text>
          );
      }
    });
  }

  return (
    <View style={styles.blocks}>
      {document ? (
        blocks(document)
      ) : (
        <Text selectable style={s.text}>
          {text}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  blocks: { gap: 8 },
  list: { gap: 4 },
  listItem: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
  },
  codeBlock: { borderWidth: 1, borderRadius: 9, overflow: 'hidden' },
  codeLanguage: { paddingHorizontal: 10, paddingVertical: 4 },
  codeBody: { padding: 10 },
  quote: { borderLeftWidth: 2, paddingLeft: 10 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1 },
  cell: {
    width: 154,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRightWidth: 1,
  },
  link: { textDecorationLine: 'underline' },
  em: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
});
