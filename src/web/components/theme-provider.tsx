import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  applyTheme,
  DARK_QUERY,
  type ResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ThemeChoice,
} from "@/lib/theme";

type ThemeContextValue = {
  /** What the viewer picked; "system" until they pick. */
  choice: ThemeChoice;
  /** What is painted now. */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function subscribeSystem(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const systemIsDark = () => window.matchMedia(DARK_QUERY).matches;

/** Light, Dark or System, stored per browser; the `dark` class on <html> paints it. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredTheme);
  const systemDark = useSyncExternalStore(subscribeSystem, systemIsDark);
  const resolved = resolveTheme(choice, systemDark);

  useEffect(() => applyTheme(resolved), [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    storeTheme(next);
    setChoiceState(next);
  }, []);

  const value = useMemo(
    () => ({ choice, resolved, setChoice }),
    [choice, resolved, setChoice],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme needs a <ThemeProvider> above it");
  return value;
}
