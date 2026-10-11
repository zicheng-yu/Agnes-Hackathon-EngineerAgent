import { CircleAlert, ArrowUpRight } from 'lucide-react';
import type { Health } from './types';
import './model-setup-notice.css';

export function needsModelSetup(health: Health | null): boolean {
  return Boolean(health && !health.preview && !health.publicTrial && !health.modelConfigured);
}

export default function ModelSetupNotice({ health, onOpenSettings }: { health: Health | null; onOpenSettings: () => void }) {
  if (!needsModelSetup(health)) return null;
  const missingKey = health?.hasApiKey === false;
  const disabled = health?.hasApiKey === true && health.usageEnabled === false;
  return <div className="model-setup-notice" role="status" aria-label="模型配置提醒">
    <CircleAlert size={20} aria-hidden="true" />
    <div><strong>{missingKey ? '尚未配置 API Key' : disabled ? '真实模型调用尚未启用' : '模型连接尚未配置完成'}</strong>
      <p>{missingKey ? '填写 API Key 后即可运行 AI 任务。' : disabled ? '请在模型设置中重新保存配置。' : '请在模型设置中检查 API Key 和模型名称。'} 工程资产库可继续浏览。</p></div>
    <button type="button" className="primary-button" onClick={onOpenSettings}>{missingKey ? '配置 API Key' : '完成模型配置'}<ArrowUpRight size={16} /></button>
  </div>;
}
