import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_KEY, applyTheme, readTheme, type Theme } from "./theme";

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = readTheme();
    setTheme(current);
    applyTheme(current);
  }, []);

  const choose = useCallback((next: Theme) => {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice just won't be remembered */
    }
  }, []);

  return [theme, choose];
}

/** Light / dark switch. Light is the default. */
export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (next: Theme) => void }) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={() => onChange(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line bg-surface text-fg transition-transform duration-150 ease-out active:scale-[0.96]"
    >
      {dark ? <Sun className="size-5" strokeWidth={1.75} /> : <Moon className="size-5" strokeWidth={1.75} />}
    </button>
  );
}
