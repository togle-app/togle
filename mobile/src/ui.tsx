import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

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

// Sizes and weights are those of the product design's Android pages. A phone control is 48 high.
const makeTheme = (colors: typeof light, isDark: boolean) => ({
  colors,
  isDark,
  s: StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    page: { paddingTop: 32, paddingBottom: 26, gap: 14 },
    header: {
      minHeight: 60,
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
      fontSize: 23,
      fontFamily: font.display,
      letterSpacing: -1,
    },
    topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    block: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      padding: 18,
      gap: 12,
    },
    h1: {
      fontSize: 32,
      fontFamily: font.display,
      letterSpacing: -1.4,
      color: colors.ink,
    },
    // A card's or a sheet's heading.
    h2: {
      fontSize: 20,
      fontFamily: font.display,
      letterSpacing: -0.5,
      color: colors.ink,
    },
    // A computer's name on its card.
    device: {
      fontSize: 18,
      fontFamily: font.display,
      letterSpacing: -0.45,
      color: colors.ink,
    },
    // The name of a row: a session, a waiting request.
    title: {
      fontSize: 15,
      lineHeight: 20,
      fontFamily: font.semibold,
      letterSpacing: -0.35,
      color: colors.ink,
    },
    section: {
      fontSize: 12,
      fontFamily: font.semibold,
      letterSpacing: 0.84,
      color: colors.muted,
      textTransform: 'uppercase',
    },
    text: {
      fontSize: 15,
      lineHeight: 22,
      color: colors.ink,
      fontFamily: font.regular,
    },
    // What was said in a conversation.
    message: {
      fontSize: 14,
      lineHeight: 22,
      color: colors.ink,
      fontFamily: font.regular,
    },
    // The line under a page's heading.
    subtitle: {
      fontSize: 14,
      lineHeight: 20,
      color: colors.muted,
      fontFamily: font.regular,
    },
    secondary: {
      fontSize: 13,
      lineHeight: 20,
      color: colors.muted,
      fontFamily: font.regular,
    },
    // The small grey line under a row's name, and readings.
    meta: {
      fontSize: 12,
      lineHeight: 17,
      color: colors.muted,
      fontFamily: font.regular,
    },
    label: { fontSize: 13, fontFamily: font.semibold, color: colors.ink },
    small: { fontSize: 12, fontFamily: font.semibold, color: colors.muted },
    tiny: {
      fontSize: 11,
      lineHeight: 16,
      fontFamily: font.semibold,
      color: colors.muted,
    },
    semibold: { fontFamily: font.semibold },
    strong: { fontFamily: font.semibold, color: colors.ink },
    field: {
      minHeight: 48,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 10,
      backgroundColor: colors.surface,
      color: colors.ink,
      paddingHorizontal: 13,
      fontSize: 16,
      fontFamily: font.regular,
    },
    button: {
      minHeight: 48,
      paddingHorizontal: 15,
      paddingVertical: 10,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    buttonText: {
      fontSize: 14,
      lineHeight: 19,
      fontFamily: font.bold,
      textAlign: 'center',
      color: colors.ink,
    },
    primary: { backgroundColor: colors.ink, borderColor: colors.ink },
    primaryText: { color: colors.bg },
    link: {
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      paddingHorizontal: 7,
    },
    linkText: { color: colors.accent },
    dangerText: { color: colors.danger },
    loading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      lineHeight: 19,
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
      borderRadius: 10,
      overflow: 'hidden',
    },
    divider: { borderTopWidth: 1, borderColor: colors.line },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingHorizontal: 16,
      paddingTop: 18,
      gap: 13,
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

/** The room beside a page: 16 on a phone, a little less on a narrow one, up to 38 on a tablet. */
export function useGutter() {
  const { width } = useWindowDimensions();
  return width <= 390 ? 12 : Math.round(Math.min(38, Math.max(16, width / 25)));
}

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/** The room the status bar and the gesture bar take. The app draws under both and keeps its content out of them. */
export function useInsets() {
  return useContext(SafeAreaInsetsContext) ?? NO_INSETS;
}

/**
 * The room the keyboard takes at the bottom of a view, measured on the screen. The app draws edge to edge, and there
 * neither Android nor iOS moves a view out of the keyboard's way: a view that holds a text box gives this much room at
 * its own bottom (`paddingBottom: space`), so the box stays above the keys. The view takes `ref` and `onLayout`.
 */
export function useKeyboardSpace() {
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  const top = useRef<number | undefined>(undefined);
  const [space, setSpace] = useState(0);
  const fit = useCallback(() => {
    const view = ref.current;
    const keyboardTop = top.current;
    if (keyboardTop === undefined || !view) {
      setSpace(0);
      return;
    }
    view.measureInWindow((_x, y, _width, height) => {
      // The keyboard may have gone, or moved, while the view was being measured.
      if (top.current === keyboardTop)
        setSpace(Math.max(0, Math.round(y + height - keyboardTop)));
    });
  }, []);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const shown = Keyboard.addListener(
      ios ? 'keyboardWillChangeFrame' : 'keyboardDidShow',
      event => {
        top.current = event.endCoordinates.screenY;
        fit();
      },
    );
    const hidden = Keyboard.addListener(
      ios ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        top.current = undefined;
        fit();
      },
    );
    return () => {
      top.current = undefined;
      shown.remove();
      hidden.remove();
    };
  }, [fit]);
  return { ref, space, onLayout: fit };
}

/** A page's heading grows with the window: 32 on a phone, up to 46 on a tablet. */
export function usePageTitle() {
  const { s } = useTheme();
  const { width } = useWindowDimensions();
  const size = Math.round(Math.min(46, Math.max(32, width / 20)));
  return [s.h1, { fontSize: size, letterSpacing: -0.045 * size }];
}

export function Button({
  title,
  onPress,
  primary,
  link,
  danger,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: {
  title: string;
  onPress(): void;
  primary?: boolean;
  link?: boolean;
  danger?: boolean;
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
        (pressed || disabled) && { opacity: disabled ? 0.5 : 0.72 },
      ]}
    >
      <Text
        style={[
          s.buttonText,
          primary && s.primaryText,
          link && s.linkText,
          danger && s.dangerText,
        ]}
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

export function Block({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { s } = useTheme();
  return <View style={[s.block, style]}>{children}</View>;
}

export function Sheet({
  onClose,
  children,
}: {
  onClose(): void;
  children: React.ReactNode;
}) {
  const { s, colors } = useTheme();
  const insets = useInsets();
  const keyboard = useKeyboardSpace();
  const { width } = useWindowDimensions();
  // From the bottom on a phone, a box in the middle on a tablet. Either stays above the keyboard.
  const wide = width > 600;
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View
        ref={keyboard.ref}
        onLayout={keyboard.onLayout}
        style={[
          sheetStyles.scrim,
          wide && sheetStyles.middle,
          { paddingBottom: keyboard.space },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            s.sheet,
            wide
              ? [sheetStyles.box, { borderColor: colors.line }]
              : { paddingBottom: 18 + (keyboard.space ? 0 : insets.bottom) },
          ]}
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
    backgroundColor: 'rgba(17,20,43,.43)',
  },
  middle: { justifyContent: 'center', alignItems: 'center' },
  box: {
    width: 430,
    maxWidth: '100%',
    borderWidth: 1,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    paddingHorizontal: 21,
    paddingTop: 21,
    paddingBottom: 21,
  },
});
