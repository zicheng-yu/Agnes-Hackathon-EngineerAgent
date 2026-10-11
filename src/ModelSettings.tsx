import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import './model-setup-notice.css';
import { api, jsonPost } from "./api";

export type ProviderId = "agnes-ai" | "openai-compatible" | "anthropic-compatible" | "openrouter";
type ProviderConfig = { baseUrl: string; model: string; hasKey: boolean; usageEnabled: boolean; visionEnabled?: boolean; thinkingDisabled?: boolean; billingMode?: string };
type Settings = Partial<ProviderConfig> & { providerId?: string; providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>> };
type ModelOption = { id: string; name: string; input?: string[]; selectable?: boolean; disabledReason?: string };
const providers: { id: ProviderId; label: string; protocol: string; baseUrl: string; model: string }[] = [
  { id: "agnes-ai", label: "官方 Agnes（默认）", protocol: "Agnes", baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-3.0-flash" },
  { id: "openai-compatible", label: "OpenAI 兼容接口", protocol: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "" },
  { id: "anthropic-compatible", label: "Anthropic 兼容接口", protocol: "Anthropic-compatible", baseUrl: "https://api.anthropic.com", model: "" },
  { id: "openrouter", label: "OpenRouter", protocol: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "minimax/minimax-m3" },
];
const validProvider = (value: unknown): value is ProviderId => providers.some((provider) => provider.id === value);
function configurations(response: Settings): Record<ProviderId, ProviderConfig> {
  const active = validProvider(response.providerId) ? response.providerId : response.providerId ? undefined : "agnes-ai";
  return Object.fromEntries(providers.map((provider) => {
    const saved = response.providers?.[provider.id] || {};
    const current = provider.id === active ? response : {};
    return [provider.id, { baseUrl: current.baseUrl ?? saved.baseUrl ?? provider.baseUrl, model: current.model ?? saved.model ?? provider.model,
      hasKey: current.hasKey ?? saved.hasKey ?? false, usageEnabled: current.usageEnabled ?? saved.usageEnabled ?? false,
      visionEnabled: current.visionEnabled ?? saved.visionEnabled ?? true, thinkingDisabled: current.thinkingDisabled ?? saved.thinkingDisabled ?? false, billingMode: current.billingMode ?? saved.billingMode }];
  })) as Record<ProviderId, ProviderConfig>;
}

/** Model connection dialog, opened from the model chip in a task composer. */
export default function ModelSettings({ refresh, onClose, locked = false }: { refresh: () => void; onClose: () => void; locked?: boolean }) {
  const [selected, setSelected] = useState<ProviderId>("agnes-ai");
  const [configs, setConfigs] = useState<Record<ProviderId, ProviderConfig> | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    api<Settings>("/api/settings", { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setSelected(validProvider(value.providerId) ? value.providerId : "agnes-ai"); setConfigs(configurations(value));
    }).catch((cause) => { if (!controller.signal.aborted) setError(`无法读取模型设置：${(cause as Error).message}`); });
    return () => controller.abort();
  }, [loadAttempt]);
  useEffect(() => {
    if (selected !== "openrouter" || models.length) return;
    const controller = new AbortController();
    api<{ models: ModelOption[] }>("/api/models?providerId=openrouter", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted && Array.isArray(value.models)) setModels(value.models);
    }).catch(() => {});
    return () => controller.abort();
  }, [selected, models.length]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const config = configs?.[selected];
  const provider = providers.find((value) => value.id === selected)!;
  const selectedModel = selected === "openrouter" ? models.find((model) => model.id === config?.model) : undefined;
  function update(patch: Partial<ProviderConfig>) { setConfigs((current) => current ? { ...current, [selected]: { ...current[selected], ...patch } } : current); setMessage(""); }
  async function save() {
    if (!config || saving || selectedModel?.selectable === false) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const receipt = await api<{ endpointKeyCleared?: boolean }>("/api/settings", jsonPost({ providerId: selected, baseUrl: config.baseUrl.trim(), model: config.model.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) }));
      setKey("");
      const saved = await api<Settings>("/api/settings");
      setConfigs(configurations(saved)); setSelected(validProvider(saved.providerId) ? saved.providerId : selected);
      setMessage(receipt.endpointKeyCleared ? "API 地址已更换，原密钥已清除，请填写新服务的 API Key。" : `已切换到 ${provider.label} · ${config.model.trim()}`); refresh();
      // A completed switch closes the dialog shortly; the composer chip then shows the new model.
      if (!receipt.endpointKeyCleared) setTimeout(onClose, 700);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }
  const dialog = (content: ReactNode) => <div className="modal-backdrop" onClick={onClose}>
    <section className="model-dialog" role="dialog" aria-modal="true" aria-label="模型设置" onClick={(event) => event.stopPropagation()}>
      <header><h2>模型</h2><button type="button" className="icon-button" aria-label="关闭模型设置" onClick={onClose}><X size={18} /></button></header>
      {content}
    </section>
  </div>;
  return dialog(<>
    {error ? <p className="inline-error" role="alert">{error}{!configs ? <button type="button" className="text-button" onClick={() => setLoadAttempt((value) => value + 1)}>重新读取</button> : null}</p> : null}
    {!configs || !config ? !error ? <div className="model-dialog-body"><LoaderCircle aria-label="读取模型设置" className="spin" /></div> : null : <>
      {locked ? <div className="model-setup-notice settings-key-notice" role="status" aria-label="在线体验版说明"><CircleAlert size={20} /><div><strong>在线体验版使用 {config.model || "部署方配置的模型"}，不能修改模型连接</strong><p>接口与密钥由部署方配置，访客无需填写 API Key。如需连接自己的模型服务，请下载本地运行包。</p></div></div> : null}
      {!locked && !config.hasKey ? <div className="model-setup-notice settings-key-notice" role="status" aria-label="API Key 配置提醒"><CircleAlert size={20} /><div><strong>此接口尚未保存 API Key</strong><p id="api-key-help">填写密钥并保存后即可运行任务。</p></div></div> : null}
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (!locked) void save(); }}><fieldset className="settings-fieldset" disabled={locked}>
        <label>模型接口<select aria-label="模型接口" value={selected} disabled={saving} onChange={(event) => { setSelected(event.target.value as ProviderId); setKey(""); setMessage(""); setError(""); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>API 地址<input aria-label="API 地址" type="url" value={config.baseUrl} readOnly={selected === "openrouter"} disabled={saving} required onChange={(event) => update({ baseUrl: event.target.value })} /></label>
        <label>模型名称<input aria-label="模型名称" value={config.model} disabled={saving} required placeholder="填写服务商提供的模型 ID" list={selected === "openrouter" ? "provider-models" : undefined} onChange={(event) => update({ model: event.target.value })} /></label>
        {selected === "openrouter" ? <datalist id="provider-models">{models.filter((model) => model.selectable !== false).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist> : null}
        {selectedModel?.selectable === false ? <p className="inline-error" role="alert">{selectedModel.disabledReason || "此模型不满足当前工具或预算限制。"}</p> : null}
        <label>API Key<input aria-label="API Key" aria-describedby={!config.hasKey ? 'api-key-help' : undefined} type="password" autoComplete="off" spellCheck={false} value={key} disabled={saving} placeholder={locked ? (config.hasKey ? "由部署方配置" : "未配置") : config.hasKey ? "已保存密钥 · 留空保持" : "填写此接口的 API Key"} onChange={(event) => { setKey(event.target.value); setMessage(""); }} /></label>
        <div className="model-dialog-actions">
          {message ? <span className="save-message" role="status" aria-label="配置保存结果">{message}</span> : <span />}
          <button className="primary-button" type="submit" disabled={saving || !config.model.trim() || !config.baseUrl.trim() || selectedModel?.selectable === false}>{saving ? <><LoaderCircle size={16} className="spin" />正在保存</> : "保存并使用"}</button>
        </div>
      </fieldset></form>
    </>}
  </>);
}
