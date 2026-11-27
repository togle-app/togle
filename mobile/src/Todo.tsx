import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { deviceStore } from './account';
import type { Device, Request, Task } from './device-client';
import { AgentMark, agentName, Icon } from './icons';
import { Button, ErrorMessage, Sheet, usePageTitle, useTheme } from './ui';

export type WaitingQuestion = { host: Device; task: Task; request: Request };
type Item = { id: string; title: string; done: boolean };
const storageKey = 'personal-todos-v1';

export function Todo({
  userId,
  waiting,
  onOpen,
}: {
  userId: string;
  waiting: WaitingQuestion[];
  onOpen(host: Device, task: Task): void;
}) {
  const { s, colors } = useTheme();
  const heading = usePageTitle();
  const store = useMemo(() => deviceStore(userId), [userId]);
  const [items, setItems] = useState<Item[]>();
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<Item>();
  const [edit, setEdit] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const saving = useRef(false);

  useEffect(() => {
    let active = true;
    store.read<Item[]>(storageKey).then(
      value => {
        if (!active) return;
        if (value !== null && !Array.isArray(value)) {
          setError('Could not read your to-dos on this phone.');
          return;
        }
        setItems(value ?? []);
      },
      () => {
        if (active) setError('Could not read your to-dos on this phone.');
      },
    );
    return () => {
      active = false;
    };
  }, [store, reload]);

  async function save(next: Item[]) {
    if (!items || saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await store.write(storageKey, next);
      setItems(next);
      return true;
    } catch {
      setError('Could not save your to-dos. Try again.');
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function add() {
    const title = draft.trim();
    if (!items || !title || saving.current) return;
    const id =
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    if (await save([{ id, title, done: false }, ...items])) {
      setDraft('');
      Keyboard.dismiss();
    }
  }

  function closeMenu() {
    setMenu(undefined);
    setEdit(undefined);
  }

  async function editItem() {
    const title = edit?.trim();
    if (!items || !menu || !title) return;
    if (
      await save(
        items.map(item => (item.id === menu.id ? { ...item, title } : item)),
      )
    )
      closeMenu();
  }

  const ordered = [...(items ?? [])].sort(
    (a, b) => Number(a.done) - Number(b.done),
  );
  return (
    <>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={heading}>
          To-do
        </Text>
        <Text style={s.subtitle}>
          {new Intl.DateTimeFormat(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          }).format(new Date())}
        </Text>
      </View>
      <View style={styles.add}>
        <TextInput
          accessibilityLabel="Add a to-do"
          testID="todo-draft"
          style={[s.field, styles.addField, s.grow]}
          placeholder="Add a to-do"
          placeholderTextColor={colors.muted}
          value={draft}
          onChangeText={setDraft}
          editable={!!items && !busy}
          returnKeyType="done"
          onSubmitEditing={add}
        />
        <Button
          title="Add"
          primary
          disabled={!items || !draft.trim() || busy}
          onPress={add}
        />
      </View>
      {!!waiting.length && (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={s.section}>
            Waiting for you
          </Text>
          <View style={s.panel}>
            {waiting.map(({ host, task, request }, index) => (
              <View
                key={JSON.stringify([host.device, task.key, request.id])}
                style={[styles.waiting, index > 0 && s.divider]}
              >
                <View style={styles.mark}>
                  <AgentMark agent={task.agent} />
                </View>
                <View style={s.grow}>
                  <Text style={s.title}>{task.title}</Text>
                  <Text style={[s.meta, styles.from]}>
                    {agentName(task.agent)} · {host.name}
                  </Text>
                  <Text
                    style={[s.secondary, styles.asked, { color: colors.ink }]}
                    numberOfLines={3}
                  >
                    {request.question}
                  </Text>
                </View>
                <Button
                  title="Reply"
                  accessibilityLabel={'Reply to ' + task.title}
                  onPress={() => onOpen(host, task)}
                />
              </View>
            ))}
          </View>
        </View>
      )}
      <View style={styles.section}>
        <View style={styles.listHeader}>
          <View>
            <Text accessibilityRole="header" style={s.section}>
              Personal to-dos
            </Text>
            <Text style={s.meta}>On this phone</Text>
          </View>
          {!!items?.length && (
            <Button
              title="Clear list"
              link
              disabled={busy}
              onPress={() => {
                Alert.alert(
                  'Clear personal to-dos?',
                  'This removes all personal to-dos saved on this phone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Clear list',
                      style: 'destructive',
                      onPress: () => save([]),
                    },
                  ],
                );
              }}
            />
          )}
        </View>
        <ErrorMessage message={menu ? '' : error} />
        {!items && !!error && (
          <Button
            title="Try again"
            onPress={() => {
              setError('');
              setReload(value => value + 1);
            }}
          />
        )}
        {items && (
          <View style={s.panel}>
            {ordered.length ? (
              ordered.map((item, index) => (
                <View
                  key={item.id}
                  style={[styles.todoRow, index > 0 && s.divider]}
                >
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={item.title}
                    accessibilityState={{ checked: item.done, disabled: busy }}
                    disabled={busy}
                    style={[styles.toggle, s.grow]}
                    onPress={() =>
                      save(
                        items.map(current =>
                          current.id === item.id
                            ? { ...current, done: !current.done }
                            : current,
                        ),
                      )
                    }
                  >
                    <View
                      style={[
                        styles.checkbox,
                        {
                          borderColor: item.done ? colors.accent : colors.line,
                        },
                        item.done && { backgroundColor: colors.tint },
                      ]}
                    >
                      {item.done && (
                        <Icon name="check" color={colors.accent} size={14} />
                      )}
                    </View>
                    <Text
                      style={[
                        s.text,
                        s.grow,
                        item.done && [
                          styles.completed,
                          { color: colors.muted },
                        ],
                      ]}
                    >
                      {item.title}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={'Options for ' + item.title}
                    disabled={busy}
                    style={styles.more}
                    onPress={() => {
                      setError('');
                      setMenu(item);
                    }}
                  >
                    <Icon name="more" color={colors.ink} size={19} />
                  </Pressable>
                </View>
              ))
            ) : (
              <Text style={[s.secondary, styles.empty]}>
                Nothing on your list. Add what you need to do today.
              </Text>
            )}
          </View>
        )}
      </View>
      {menu && (
        <Sheet onClose={closeMenu}>
          <Text accessibilityRole="header" style={s.h2}>
            {edit === undefined ? menu.title : 'Edit to-do'}
          </Text>
          <ErrorMessage message={error} />
          {edit === undefined ? (
            <>
              <Button title="Edit" onPress={() => setEdit(menu.title)} />
              <Button
                title="Remove"
                disabled={busy}
                onPress={async () => {
                  if (
                    items &&
                    (await save(items.filter(item => item.id !== menu.id)))
                  )
                    closeMenu();
                }}
              />
            </>
          ) : (
            <>
              <TextInput
                accessibilityLabel="To-do title"
                testID="todo-edit"
                autoFocus
                style={s.field}
                editable={!busy}
                value={edit}
                onChangeText={setEdit}
                returnKeyType="done"
                onSubmitEditing={editItem}
              />
              <Button
                title="Save"
                primary
                onPress={editItem}
                disabled={busy || !edit.trim()}
              />
            </>
          )}
          <Button title="Cancel" link onPress={closeMenu} />
        </Sheet>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 7, marginBottom: 4 },
  add: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  addField: { borderRadius: 8, paddingHorizontal: 11 },
  section: { gap: 10, marginTop: 11 },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mark: { alignSelf: 'flex-start', marginTop: 4 },
  from: { marginTop: 3 },
  asked: { marginTop: 5 },
  empty: { padding: 18 },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  todoRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 59,
    paddingHorizontal: 15,
    paddingVertical: 14,
  },
  checkbox: {
    width: 19,
    height: 19,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  more: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completed: { textDecorationLine: 'line-through' },
});
