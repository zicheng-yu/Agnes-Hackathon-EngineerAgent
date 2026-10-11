import {render, screen, cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ThemeProvider, ThemeSwitch, readTheme} from '../../src/Theme';

beforeEach(() => {localStorage.clear(); document.documentElement.removeAttribute('data-theme');});
afterEach(() => {localStorage.clear(); document.documentElement.removeAttribute('data-theme'); vi.restoreAllMocks();});
it('defaults to light and preserves a chosen dark theme after remount', async () => {
 const user = userEvent.setup();
 render(<ThemeProvider><ThemeSwitch/><input aria-label="当前采购草稿" defaultValue="采购 300 件"/></ThemeProvider>);
 expect(document.documentElement).toHaveAttribute('data-theme','light');
 expect(screen.getByRole('button',{name:'浅色主题'})).toHaveAttribute('aria-pressed','true');
 await user.click(screen.getByRole('button',{name:'深色主题'}));
 expect(document.documentElement).toHaveAttribute('data-theme','dark');
 expect(screen.getByRole('textbox',{name:'当前采购草稿'})).toHaveValue('采购 300 件');
 expect(localStorage.getItem('engineeragent-theme')).toBe('dark');
 cleanup(); render(<ThemeProvider><ThemeSwitch/></ThemeProvider>);
 expect(screen.getByRole('button',{name:'深色主题'})).toHaveAttribute('aria-pressed','true');
 await user.click(screen.getByRole('button',{name:'浅色主题'}));
 expect(document.documentElement).toHaveAttribute('data-theme','light');
 expect(readTheme()).toBe('light');
});
it('falls back safely when storage is unavailable or has an invalid value', async () => {
 localStorage.setItem('engineeragent-theme','invalid'); expect(readTheme()).toBe('light');
 vi.spyOn(Storage.prototype,'getItem').mockImplementation(() => {throw new Error('Blocked');});
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => {throw new Error('Blocked');});
 render(<ThemeProvider><ThemeSwitch/></ThemeProvider>);
 expect(document.documentElement).toHaveAttribute('data-theme','light');
 await userEvent.setup().click(screen.getByRole('button',{name:'深色主题'}));
 expect(document.documentElement).toHaveAttribute('data-theme','dark');
});
