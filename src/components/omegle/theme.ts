export type Theme = "light" | "dark";

export const THEME_KEY = "omegle-theme";

/** Light unless the person has chosen dark. */
export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#121410" : "#f6f4ec");
}

/**
 * Runs in <head> before the first paint so a saved dark choice doesn't flash
 * white. Keep this tiny and dependency-free.
 */
export const THEME_BOOT_SCRIPT = `try{var d=localStorage.getItem("${THEME_KEY}")==="dark"?"dark":"light";var r=document.documentElement;r.dataset.theme=d;r.style.colorScheme=d;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",d==="dark"?"#121410":"#f6f4ec")}catch(e){document.documentElement.dataset.theme="light"}`;
