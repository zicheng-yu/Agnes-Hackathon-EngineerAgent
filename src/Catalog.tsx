import {useEffect,useMemo,useRef,useState} from "react";
import {Box,Maximize2,Plus,Search,SlidersHorizontal,X} from "lucide-react";
import type {Asset} from "./types";
function AssetImage({ asset }: { asset: Asset }) {
  const [image, setImage] = useState(asset.thumbnailUrl || "");
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setImage(asset.thumbnailUrl || "");
    setFailed(false);
    if (asset.thumbnailUrl || !asset.modelUrl) return;
    let stopped = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((x) => x.isIntersecting)) {
          observer.disconnect();
          import('./three-utils').then(({thumbnail}) => thumbnail(asset.modelUrl!))
            .then((x) => {
              if (!stopped) setImage(x);
            })
            .catch(() => {
              if (!stopped) setFailed(true);
            });
        }
      },
      { rootMargin: "250px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      stopped = true;
      observer.disconnect();
    };
  }, [asset.modelUrl, asset.thumbnailUrl]);
  return (
    <div className="asset-image" ref={ref}>
      {image ? (
        <img src={image} alt={asset.name} loading="lazy" />
      ) : (
        <div className="asset-placeholder">
          <Box size={28} />
          <span>{failed ? "缩略图暂不可用" : "读取几何"}</span>
        </div>
      )}
    </div>
  );
}
function AssetCard({
  asset,
  onOpen,
}: {
  asset: Asset;
  onOpen: () => void;
}) {
  return (
    <button className="asset-card" onClick={onOpen} data-asset-id={asset.id} data-asset-code={asset.displayCode || asset.id}>
      <div className="card-corner">
        <span className="mono">{asset.displayCode || asset.id}</span>
        <Maximize2 size={13} />
      </div>
      <AssetImage asset={asset} />
      <div className="asset-body">
        <div className="asset-meta">
          <span>{asset.category}</span>
          <span className="file-badge">{asset.format || "CAD"}</span>
        </div>
        <h3>{asset.name}</h3>
        <p>{asset.useCase || asset.summary || "参数化机械组件"}</p>
      </div>
    </button>
  );
}

export default function Catalog({
  assets,
  onSelect,
  onUpload,
}: {
  assets: Asset[];
  onSelect: (a: Asset) => void;
  onUpload: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部资产");
  const [filterOpen, setFilterOpen] = useState(false);
  const [format, setFormat] = useState("全部格式");
  const categories = useMemo(
    () => ["全部资产", ...new Set(assets.map((x) => x.category))],
    [assets],
  );
  const filtered = useMemo(
    () =>
      assets.filter(
        (x) =>
          (category === "全部资产" || x.category === category) &&
          (format === "全部格式" || x.format === format) &&
          `${x.name} ${x.id} ${x.displayCode || ""} ${x.category} ${x.useCase}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [assets, category, format, query],
  );
  return (
    <>
      <div className="page-title">
        <div>
          <h1>工程资产库</h1>
          <p>带来源与许可的机械零件和装配体，可查看三维模型、拆解视图与部件清单。</p>
        </div>
        <button className="secondary-button" onClick={onUpload}>
          <Plus size={16} />
          导入图纸重建
        </button>
      </div>
      <div className="catalog-toolbar">
        <div className="catalog-tools">
          <label className="search">
            <Search size={15} />
            <input
              placeholder="搜索零件、用途或编号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索资产"
            />
          </label>
          <button
            className={`filter-button ${filterOpen ? "active" : ""}`}
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <SlidersHorizontal size={15} />
            筛选
          </button>
                  <span className="filter-result-count" role="status" aria-live="polite">
            显示 {filtered.length}/{assets.length} 资产
          </span>
        </div>
        <div className="category-row">
          {categories.map((c) => (
            <button
              key={c}
              aria-label={c === "全部资产" ? `全部资产 ${assets.length}` : c}
              className={category === c ? "selected" : ""}
              onClick={() => setCategory(c)}
            >
              {c}
              {c === "全部资产" ? <span>{assets.length}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {filterOpen ? (
        <div className="filter-panel">
          <label>
            源文件格式{" "}
            <select aria-label="源文件格式" value={format} onChange={(e) => setFormat(e.target.value)}>
              <option>全部格式</option>
              <option>STEP</option>
              <option>STL</option>
            </select>
          </label>
          <button
            onClick={() => {
              setFormat("全部格式");
              setCategory("全部资产");
              setQuery("");
            }}
          >
            清空筛选
          </button>
        </div>
      ) : null}
      {(format !== "全部格式" || category !== "全部资产" || query) ? <div className="active-filters" aria-label="已应用筛选">
        {format !== "全部格式" ? <button className="filter-chip" aria-label={`移除 ${format} 格式筛选`} onClick={()=>setFormat("全部格式")}>{format}<X size={15}/></button> : null}
        {category !== "全部资产" ? <button className="filter-chip" aria-label={`移除 ${category} 分类筛选`} onClick={()=>setCategory("全部资产")}>{category}<X size={15}/></button> : null}
        {query ? <button className="filter-chip" aria-label="清除搜索关键词" onClick={()=>setQuery("")}>搜索：{query}<X size={15}/></button> : null}
        <button className="filter-clear" onClick={()=>{setFormat("全部格式");setCategory("全部资产");setQuery("");}}>清空全部</button>
      </div> : null}
      <div className="asset-grid">
        {filtered.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            onOpen={() => onSelect(asset)}
          />
        ))}
      </div>
      {!filtered.length ? (
        <div className="empty-state">
          <Search size={30} />
          <h3>{assets.length ? "没有匹配的资产" : "正在整理工程资产"}</h3>
          <p>
            {assets.length
              ? "换一个名称、用途或分类试试。"
              : "真实模型载入后会出现在这里。"}
          </p>
        </div>
      ) : null}
    </>
  );
}
