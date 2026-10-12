import { useEffect, useState } from "react";
import {
  Activity,
  Box,
  Boxes,
  CirclePlay,
  Download,
  ExternalLink,
  FileText,
  Layers3,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import Viewer from "./ModelViewer";
import Catalog from "./Catalog";
import TasksPanel from "./TaskHistory";
import TaskWorkspace from "./TaskWorkspace";
import ModelSetupNotice from './ModelSetupNotice';
import ModelSettings from "./ModelSettings";
import DemoVideo from "./DemoVideo";
import {ThemeSwitch} from "./Theme";
import { api } from "./api";
import type { Asset, Health } from "./types";

type Page = "agent" | "catalog" | "workbench" | "orders" | "search" | "tasks";
const chatPages: Page[] = ["agent", "workbench", "orders", "search"];
const navigation: { id: Page; label: string; icon: typeof Box }[] = [
  { id: "agent", label: "任务工作台", icon: Terminal },
  { id: "catalog", label: "工程资产库", icon: Boxes },
  { id: "workbench", label: "图纸重建", icon: Layers3 },
  { id: "orders", label: "订单评审", icon: FileText },
  { id: "search", label: "零件检索", icon: Search },
  { id: "tasks", label: "历史记录", icon: Activity },
];
function sourceLabel(asset: Asset) {
  return asset.sourceType === "public-open-hardware"
    ? "开源工程资产"
    : "原创参数模型";
}
function AssetDetail({
  asset,
  onClose,
  onReconstruct,
}: {
  asset: Asset;
  onClose: () => void;
  onReconstruct: () => void;
}) {
  const [tab, setTab] = useState<"spec" | "source" | "bom">("spec");
  const [count, setCount] = useState(0);
  const [manifest, setManifest] = useState<any>(null);
  const [highlight, setHighlight] = useState("");
  useEffect(() => {
    setManifest(null);
    if (asset.manifestUrl)
      api(asset.manifestUrl)
        .then(setManifest)
        .catch(() => {});
  }, [asset.manifestUrl]);
  useEffect(() => {
    let fullscreenActive=Boolean(document.fullscreenElement);
    let lastFullscreenExit=0;
    const fullscreenChanged=()=>{const next=Boolean(document.fullscreenElement);if(fullscreenActive&&!next)lastFullscreenExit=Date.now();fullscreenActive=next;};
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement && Date.now()-lastFullscreenExit>250) onClose();
    };
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    window.addEventListener("keydown", key);
    document.addEventListener('fullscreenchange',fullscreenChanged);
    return () => {window.removeEventListener("keydown", key);document.removeEventListener('fullscreenchange',fullscreenChanged);document.body.style.overflow=previousOverflow;};
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={asset.name}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <span className="modal-kicker mono">
              {asset.displayCode || asset.id} · {asset.category}
            </span>
            <h2>{asset.name}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭模型详情"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <div className="detail-layout">
          <Viewer
            url={asset.modelUrl}
            name={asset.id}
            manifestUrl={asset.manifestUrl}
            highlight={highlight}
            fallbackImageUrl={asset.thumbnailUrl}
            downloadUrl={asset.sourceModelUrl || asset.stepUrl || asset.modelUrl}
            onParts={setCount}
          />
          <aside className="detail-info">
            <div className="tabs">
              <button
                className={tab === "spec" ? "selected" : ""}
                onClick={() => setTab("spec")}
              >
                资产信息
              </button>
              <button
                className={tab === "source" ? "selected" : ""}
                onClick={() => setTab("source")}
              >
                来源与许可
              </button>
              {manifest?.bom ? (
                <button
                  className={tab === "bom" ? "selected" : ""}
                  onClick={() => setTab("bom")}
                >
                  部件清单
                </button>
              ) : null}
            </div>
            {tab === "spec" ? (
              <>
                <div className="detail-section">
                  <span className="label">应用场景</span>
                  <h3>{asset.useCase || "机械结构与工程验证"}</h3>
                  <p>{asset.summary}</p>
                </div>
                <dl className="spec-list">
                  <div>
                    <dt>资产类型</dt>
                    <dd>{sourceLabel(asset)}</dd>
                  </div>
                  <div>
                    <dt>源文件</dt>
                    <dd className="mono">{asset.format || "STEP"}</dd>
                  </div>
                  <div>
                    <dt>几何单元</dt>
                    <dd className="mono">{count || "—"}</dd>
                  </div>
                  <div>
                    <dt>材料</dt>
                    <dd>{asset.material || "来源未标注"}</dd>
                  </div>
                  <div>
                    <dt>几何验证</dt>
                    <dd>
                      {manifest?.measurements?.valid === true
                        ? "实体有效"
                        : asset.format === "STL"
                          ? "网格模型"
                          : "查看源记录"}
                    </dd>
                  </div>
                  {manifest?.measurements?.bbox?.size &&
                  asset.format !== "STL" ? (
                    <div>
                      <dt>包围尺寸 mm</dt>
                      <dd className="mono">
                        {manifest.measurements.bbox.size
                          .map((n: number) => n.toFixed(1))
                          .join(" × ")}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <div className="info-note">
                  <ShieldCheck size={17} />
                  <span>
                    公开设计可用于结构研究。来源模型与本企业的制造记录分别管理。
                  </span>
                </div>
              </>
            ) : tab === "bom" ? (
              <div className="bom-list">
                <p className="muted">选择零件以高亮对应实例。</p>
                {manifest?.bom.map((b: any) => (
                  <button
                    key={b.part_id}
                    className={highlight === b.part_id ? "selected" : ""}
                    onClick={() =>
                      setHighlight(highlight === b.part_id ? "" : b.part_id)
                    }
                  >
                    <Box size={15} />
                    <span>{b.name}</span>
                    <strong className="mono">×{b.quantity}</strong>
                  </button>
                ))}
                <div className="info-note">
                  {manifest?.verification?.path_check_passed
                    ? "分步平移路径已通过离散采样检查。"
                    : "路径检查结果见几何报告。"}
                </div>
              </div>
            ) : (
              <>
                <div className="detail-section">
                  <span className="label">作者 / 项目</span>
                  <h3>{asset.author || "项目原创设计"}</h3>
                  <p>{(asset.sourceProject as string) || "EngineerAgent"}</p>
                </div>
                <dl className="spec-list">
                  <div>
                    <dt>使用许可</dt>
                    <dd className="mono">{asset.license || "见项目说明"}</dd>
                  </div>
                  <div>
                    <dt>资产来源</dt>
                    <dd>{sourceLabel(asset)}</dd>
                  </div>
                </dl>
                <p className="muted detail-source">
                  {(asset.notes as string) || "模型由项目内参数化工具构建。"}
                </p>
                {asset.sourceUrl ? (
                  <a
                    className="secondary-button full"
                    href={asset.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看上游设计 <ExternalLink size={15} />
                  </a>
                ) : null}
              </>
            )}
            <div className="detail-actions">
              <a
                className="secondary-button"
                href={asset.sourceModelUrl || asset.stepUrl || asset.modelUrl}
                download
              >
                <Download size={16} />
                下载模型
              </a>
              <button className="primary-button" onClick={onReconstruct}>
                <Layers3 size={16} />
                图纸重建
              </button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("agent");
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [healthError, setHealthError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const error = healthError || catalogError;
  const refreshHealth = () => api<Health>('/api/health').then(h => { setHealth(h); setHealthError(''); }).catch(e => setHealthError(`${e.message} 连接恢复后将自动更新。`));
  const refreshCatalog = () => api<Asset[]>('/api/catalog').then(a => {
    a.sort((x,y) => Number(Boolean(y.hero)) - Number(Boolean(x.hero)));
    setAssets(previous => JSON.stringify(previous) === JSON.stringify(a) ? previous : a);
    setCatalogError('');
  }).catch(e => setCatalogError(`${e.message} 连接恢复后将自动更新。`));
  const refresh = () => { void refreshCatalog(); void refreshHealth(); };
  useEffect(() => {
    refresh();
    const healthTimer = setInterval(() => { if (!document.hidden) void refreshHealth(); }, 10000);
    const catalogTimer = setInterval(() => { if (!document.hidden) void refreshCatalog(); }, 60000);
    const reconnect = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', reconnect);
    window.addEventListener('online', reconnect);
    return () => { clearInterval(healthTimer); clearInterval(catalogTimer); document.removeEventListener('visibilitychange', reconnect); window.removeEventListener('online', reconnect); };
  }, []);
  const [modelDialog, setModelDialog] = useState(false);
  const openModel = () => setModelDialog(true);
  const [videoOpen, setVideoOpen] = useState(false);
  const title = navigation.find((x) => x.id === page)?.label;
  useEffect(() => { document.title = title ? `${title} · EngineerAgent` : "EngineerAgent"; }, [title]);
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("agent");
          }}
        >
          <div className="brand-symbol">
            <span />
            <span />
            <span />
          </div>
          <div>EngineerAgent</div>
        </a>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
              aria-label={label}
              aria-current={page === id ? "page" : undefined}
              title={label}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {health?.demoVideo ? <button type="button" className="bottom-link" onClick={() => setVideoOpen(true)} title="演示视频"><CirclePlay size={18} /><span>演示视频</span></button> : null}
          <ThemeSwitch />
        </div>
      </aside>
      <div className="app-body">
        <main className={chatPages.includes(page) ? "main--chat" : undefined}>
          {error ? <div className="inline-error">{error}</div> : null}
          {page === "catalog" || page === "tasks" ? <ModelSetupNotice health={health} onOpenSettings={openModel} /> : null}
          <TaskWorkspace storageKey="home" active={page === 'agent'} health={health} assets={assets} onSelectAsset={setSelected} onOpenSettings={openModel} />
          <TaskWorkspace storageKey="workbench" active={page === 'workbench'} fixedMode="reconstruct" health={health} assets={assets} onSelectAsset={setSelected} onOpenSettings={openModel} />
          <TaskWorkspace storageKey="orders" active={page === 'orders'} fixedMode="order_review" health={health} assets={assets} onSelectAsset={setSelected} onOpenSettings={openModel} />
          <TaskWorkspace storageKey="search" active={page === 'search'} fixedMode="catalog_search" health={health} assets={assets} onSelectAsset={setSelected} onOpenSettings={openModel} />
          {page === "catalog" ? (
            <Catalog
              assets={assets}
              onSelect={setSelected}
              onUpload={() => setPage("workbench")}
            />
          ) : page === "tasks" ? (
            <TasksPanel assets={assets} onSelectAsset={setSelected} />
          ) : null}
        </main>

      </div>
      {videoOpen && health?.demoVideo ? <DemoVideo video={health.demoVideo} onClose={() => setVideoOpen(false)} /> : null}
      {modelDialog ? <ModelSettings refresh={refresh} locked={health?.hostedDemo === true} onClose={() => setModelDialog(false)} /> : null}
      {selected ? (
        <AssetDetail
          asset={selected}
          onClose={() => setSelected(null)}
          onReconstruct={() => {
            setSelected(null);
            setPage("workbench");
          }}
        />
      ) : null}
    </div>
  );
}
