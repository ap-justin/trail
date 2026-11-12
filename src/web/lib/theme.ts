export const themeChoices = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof themeChoices)[number];
export const themeLabels: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export type ResolvedTheme = "light" | "dark";

/** Also read by public/theme-init.js, which runs before the app bundle. */
export const THEME_STORAGE_KEY = "trail-theme";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function readStoredTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return themeChoices.find((c) => c === stored) ?? "system";
  } catch {
    return "system";
  }
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // storage blocked: the choice lasts until reload
  }
}

export function resolveTheme(
  choice: ThemeChoice,
  systemDark: boolean,
): ResolvedTheme {
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
