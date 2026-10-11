import {createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode} from 'react';
import {Moon, Sun} from 'lucide-react';

export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'engineeragent-theme';
export function readTheme(): Theme {
  try { return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f6f6f4' : '#121416');
}
const ThemeContext = createContext<{theme: Theme; setTheme: (theme: Theme) => void}>({theme:'light', setTheme: () => {}});
export function ThemeProvider({children}: {children: ReactNode}) {
  const [theme, updateTheme] = useState<Theme>(readTheme);
  useLayoutEffect(() => { applyTheme(theme); }, [theme]);
  const setTheme = useCallback((next: Theme) => {
    updateTheme(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Session switching remains available without storage. */ }
  }, []);
  const value = useMemo(() => ({theme, setTheme}), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
export function ThemeSwitch() {
  const {theme, setTheme} = useTheme();
  return <div className="theme-switch" role="group" aria-label="外观主题">
    <button type="button" aria-label="浅色主题" aria-pressed={theme === 'light'} title="浅色主题" onClick={() => setTheme('light')}><Sun size={15}/><span>浅色</span></button>
    <button type="button" aria-label="深色主题" aria-pressed={theme === 'dark'} title="深色主题" onClick={() => setTheme('dark')}><Moon size={15}/><span>深色</span></button>
  </div>;
}
