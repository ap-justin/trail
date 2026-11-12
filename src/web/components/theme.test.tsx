import { readFileSync } from "node:fs";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AccountPanel } from "@/components/account-panel";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { THEME_STORAGE_KEY } from "@/lib/theme";

const html = document.documentElement;
const realMatchMedia = window.matchMedia;

function setSystemDark(dark: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: dark,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
}

beforeEach(() => {
  localStorage.clear();
  html.classList.remove("dark");
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

function Probe() {
  const { choice, resolved } = useTheme();
  return <output>{`${choice}:${resolved}`}</output>;
}

const viewer = { name: "Maya Chen", login: "mayachen", isOwner: false };

function renderAccount() {
  render(
    <ThemeProvider>
      <Probe />
      <AccountPanel viewer={viewer} onSignOut={() => {}} />
    </ThemeProvider>,
  );
}

describe("ThemeProvider", () => {
  test("System is the default and follows the system setting", () => {
    setSystemDark(true);
    renderAccount();
    expect(screen.getByRole("status")).toHaveTextContent("system:dark");
    expect(html).toHaveClass("dark");
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("a choice is stored and applied", async () => {
    setSystemDark(false);
    renderAccount();
    expect(html).not.toHaveClass("dark");

    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(html).toHaveClass("dark");

    await userEvent.click(screen.getByRole("button", { name: "System" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(html).not.toHaveClass("dark");
  });

  test("a stored choice wins over the system on the next load", () => {
    setSystemDark(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderAccount();
    expect(screen.getByRole("status")).toHaveTextContent("light:light");
    expect(html).not.toHaveClass("dark");
  });
});

describe("public/theme-init.js, the pre-paint script", () => {
  const script = readFileSync("src/web/public/theme-init.js", "utf8");
  const run = () => act(() => new Function(script)());

  test.each([
    [null, true, true],
    [null, false, false],
    ["dark", false, true],
    ["light", true, false],
  ] as const)(
    "stored %s, system dark %s → dark class %s",
    (stored, systemDark, expected) => {
      setSystemDark(systemDark);
      if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
      run();
      expect(html.classList.contains("dark")).toBe(expected);
    },
  );
});
