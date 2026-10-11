const prefix = 'engineeragent.workspace.v1.';

// Session storage keeps drafts in this browser tab, including refreshes, without
// placing procurement text in long-lived cross-session local storage.
export function readWorkspace(key?: string): Record<string, any> {
  if (!key) return {};
  try {
    const value = JSON.parse(sessionStorage.getItem(prefix + key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function saveWorkspace(key: string | undefined, value: unknown): void {
  if (!key) return;
  try { sessionStorage.setItem(prefix + key, JSON.stringify(value)); }
  catch { /* Storage policies/quota must never break an active task. */ }
}
