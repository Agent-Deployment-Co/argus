import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** The palette actually applied to the document. */
export type Theme = "light" | "dark";
/** What the user chose. "system" follows the OS preference live. */
export type ThemePref = "system" | Theme;

const STORAGE_KEY = "argus-theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

interface ThemeCtx {
  /** The resolved palette currently applied (light/dark) — what charts etc. read. */
  theme: Theme;
  /** The user's choice; "system" tracks the OS. */
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx>({ theme: "dark", pref: "system", setPref: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The pre-paint script in index.html already set documentElement.dataset.theme; mirror it here.
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [theme, setThemeState] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  const apply = useCallback((t: Theme) => {
    document.documentElement.dataset.theme = t;
    setThemeState(t);
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    try { localStorage.setItem(STORAGE_KEY, p); } catch {}
    setPrefState(p);
  }, []);

  // Resolve the preference to a palette. When following the system, track OS changes live.
  useEffect(() => {
    if (pref !== "system") {
      apply(pref);
      return;
    }
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    apply(mq?.matches ? "light" : "dark");
    if (!mq) return;
    const onChange = () => apply(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref, apply]);

  return <Ctx.Provider value={{ theme, pref, setPref }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
