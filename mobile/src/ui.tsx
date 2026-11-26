import React, { createContext, useContext, useMemo } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const font = {
  regular: 'Togle-Text-Regular',
  semibold: 'Togle-Text-Semibold',
  bold: 'Togle-Text-Bold',
  display: 'Togle-Display-Bold',
};

const light = {
  bg: '#eef0f5',
  surface: '#fff',
  ink: '#161a24',
  muted: '#586076',
  line: '#d3d8e2',
  accent: '#4350cf',
  tint: '#e4e7ff',
  wait: '#955c06',
  amber: '#fcefd3',
  good: '#08735c',
  green: '#d6f0e7',
  danger: '#b92d2d',
  dangerSoft: '#fde0e0',
  raised: '#e8ebf2',
};
const dark: typeof light = {
  bg: '#0f1115',
  surface: '#171b23',
  ink: '#e9ecf5',
  muted: '#a0a7bc',
  line: '#2b3142',
  accent: '#98a5ff',
  tint: '#20264d',
  wait: '#e5b865',
  amber: '#352a10',
  good: '#55d3b6',
  green: '#0f322c',
  danger: '#ff7a7a',
  dangerSoft: '#3a2026',
  raised: '#1e2330',
};

const makeTheme = (colors: typeof light, isDark: boolean) => ({
  colors,
  isDark,
  s: StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    page: { padding: 18, paddingBottom: 26, gap: 18 },
    header: {
      height: 58,
      paddingHorizontal: 18,
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderColor: colors.line,
    },
    logo: { width: 32, height: 32, borderRadius: 8 },
    wordmark: {
      color: colors.ink,
      fontSize: 22,
      fontFamily: font.display,
      letterSpacing: -0.75,
    },
    topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    block: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 12,
      padding: 15,
      gap: 12,
    },
    h1: {
      fontSize: 30,
      fontFamily: font.display,
      letterSpacing: -0.8,
      color: colors.ink,
    },
    h2: { fontSize: 17, fontFamily: font.bold, color: colors.ink },
    section: {
      fontSize: 12,
      fontFamily: font.bold,
      letterSpacing: 0.85,
      color: colors.muted,
      textTransform: 'uppercase',
    },
    text: {
      fontSize: 15,
      lineHeight: 21,
      color: colors.ink,
      fontFamily: font.regular,
    },
    secondary: {
      fontSize: 13,
      lineHeight: 19,
      color: colors.muted,
      fontFamily: font.regular,
    },
    label: { fontSize: 13, fontFamily: font.semibold, color: colors.ink },
    field: {
      minHeight: 48,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 9,
      backgroundColor: colors.surface,
      color: colors.ink,
      paddingHorizontal: 12,
      fontSize: 16,
      fontFamily: font.regular,
    },
    button: {
      minHeight: 46,
      paddingHorizontal: 13,
      paddingVertical: 9,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    buttonText: {
      fontSize: 14,
      fontFamily: font.bold,
      textAlign: 'center',
      color: colors.ink,
    },
    primary: { backgroundColor: colors.ink, borderColor: colors.ink },
    primaryText: { color: colors.bg },
    link: { backgroundColor: 'transparent', borderColor: 'transparent' },
    linkText: { color: colors.accent },
    loading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    error: {
      color: colors.danger,
      fontSize: 14,
      lineHeight: 20,
      fontFamily: font.regular,
    },
    grow: { flex: 1, minWidth: 0 },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
    },
    panel: {
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      borderRadius: 12,
      overflow: 'hidden',
    },
    divider: { borderTopWidth: 1, borderColor: colors.line },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      padding: 20,
      gap: 14,
    },
  }),
});
const Theme = createContext(makeTheme(light, false));
export const useTheme = () => useContext(Theme);

export function Palette({ children }: { children: React.ReactNode }) {
  const isDark = useColorScheme() === 'dark';
  const value = useMemo(
    () => makeTheme(isDark ? dark : light, isDark),
    [isDark],
  );
  return <Theme.Provider value={value}>{children}</Theme.Provider>;
}

export function Button({
  title,
  onPress,
  primary,
  link,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: {
  title: string;
  onPress(): void;
  primary?: boolean;
  link?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { s } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        s.button,
        primary && s.primary,
        link && s.link,
        style,
        (pressed || disabled) && { opacity: disabled ? 0.45 : 0.72 },
      ]}
    >
      <Text
        style={[s.buttonText, primary && s.primaryText, link && s.linkText]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function ErrorMessage({ message }: { message: string }) {
  const { s } = useTheme();
  return message ? (
    <Text accessibilityRole="alert" style={s.error}>
      {message}
    </Text>
  ) : null;
}

export function Block({ children }: { children: React.ReactNode }) {
  const { s } = useTheme();
  return <View style={s.block}>{children}</View>;
}

export function Sheet({
  onClose,
  children,
}: {
  onClose(): void;
  children: React.ReactNode;
}) {
  const { s } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={sheetStyles.scrim}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[s.sheet, { paddingBottom: 20 + insets.bottom }]}
          accessibilityViewIsModal
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

const sheetStyles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(16,20,30,.46)',
  },
});
