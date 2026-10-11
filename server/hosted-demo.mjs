/** Hosted online-trial mode. Disabled unless ENGINEERAGENT_PUBLIC_DEMO=1; the local package is unchanged. */
export function hostedDemoConfig(env = process.env) {
  const enabled = env.ENGINEERAGENT_PUBLIC_DEMO === '1';
  const origins = enabled ? String(env.ENGINEERAGENT_PUBLIC_ORIGIN || '').split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean) : [];
  const limit = (name, fallback) => { const value = Number(env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; };
  return {
    enabled, origins,
    modelTasksPerHour: limit('ENGINEERAGENT_DEMO_TASKS_PER_HOUR', 8),
    modelTasksPerDay: limit('ENGINEERAGENT_DEMO_TASKS_PER_DAY', 200),
    toolCallsPerHour: limit('ENGINEERAGENT_DEMO_TOOLS_PER_HOUR', 60),
  };
}

/** The reverse proxy overwrites X-Real-IP; never trust a client-supplied X-Forwarded-For chain. */
export const clientAddress = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');

/** Sliding-window counters kept in memory; a restart only resets the trial allowance. */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map();
  const recent = (key, windowMs, time) => (windows.get(key) || []).filter(stamp => time - stamp < windowMs);
  return {
    /** Report whether one more event fits, without recording it. */
    check(key, max, windowMs) {
      const time = now(), stamps = recent(key, windowMs, time);
      return stamps.length < max ? { ok: true } : { ok: false, retryAfter: Math.ceil((windowMs - (time - stamps[0])) / 1000) };
    },
    record(key, windowMs) {
      const time = now(), stamps = recent(key, windowMs, time);
      stamps.push(time); windows.set(key, stamps);
      if (windows.size > 5000) for (const [entry, values] of windows) if (!values.some(stamp => time - stamp < 86_400_000)) windows.delete(entry);
    },
  };
}

export function hostedDemoGuard(config, limiter = createRateLimiter()) {
  const reject = (res, retryAfter, error) => { res.setHeader('Retry-After', String(retryAfter)); return res.status(429).json({ error }); };
  const minutes = seconds => Math.max(1, Math.ceil(seconds / 60));
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (req.path === '/api/settings') return res.status(403).json({ error: '在线体验版已由部署方固定接入官方 Agnes 3.0 Flash，不能修改模型连接。如需使用自己的 Key，请下载本地运行包。' });
    const address = clientAddress(req);
    if (req.path === '/api/tasks' && req.body?.mode !== 'geometry') {
      // Check both windows before recording, so a rejected request never spends either allowance.
      const daily = limiter.check('model:all', config.modelTasksPerDay, 86_400_000);
      if (!daily.ok) return reject(res, daily.retryAfter, '在线体验今日的模型任务额度已用完，请明天再试，或下载本地运行包使用自己的 Key。');
      const personal = limiter.check(`model:${address}`, config.modelTasksPerHour, 3_600_000);
      if (!personal.ok) return reject(res, personal.retryAfter, `体验版每小时最多提交 ${config.modelTasksPerHour} 个模型任务，请约 ${minutes(personal.retryAfter)} 分钟后再试。`);
      limiter.record('model:all', 86_400_000); limiter.record(`model:${address}`, 3_600_000);
    } else if (['/api/tasks', '/api/geometry', '/api/documents', '/api/orders/review'].includes(req.path)) {
      const tools = limiter.check(`tool:${address}`, config.toolCallsPerHour, 3_600_000);
      if (!tools.ok) return reject(res, tools.retryAfter, `操作过于频繁，请约 ${minutes(tools.retryAfter)} 分钟后再试。`);
      limiter.record(`tool:${address}`, 3_600_000);
    }
    next();
  };
}
