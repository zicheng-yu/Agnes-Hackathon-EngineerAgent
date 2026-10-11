import fs from "node:fs/promises";
import path from "node:path";
import { isWithinDirectory, portablePath } from './paths.mjs';

export function publicAssetPath(root, value, paths = path) {
  if (!value || typeof value !== "string") return undefined;
  if (/^https?:/.test(value)) return value;
  if (value.startsWith("/assets/") || value.startsWith("/runs/")) return value;
  const absolute = paths.isAbsolute(value) ? value : paths.resolve(root, value);
  if (!isWithinDirectory(root, absolute, paths)) return undefined;
  const relative = portablePath(paths.relative(root, absolute), paths);
  if (relative.startsWith("assets/"))
    return "/" + relative.split('/').map(encodeURIComponent).join("/");
  if (relative.startsWith("data/runs/"))
    return (
      "/runs/" +
      relative.slice(10).split('/').map(encodeURIComponent).join("/")
    );
}
export async function loadCatalog(root) {
  let assetCodes={};
  try{assetCodes=JSON.parse(await fs.readFile(path.join(root,'assets/asset-codes.json'),'utf8'));}catch{}
  const results = [];
  for (const name of [
    "assets/catalog/catalog.json",
    "assets/generated/catalog.json",
  ]) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
      const items = Array.isArray(data)
        ? data
        : [
            ...(data.assemblies || []),
            ...(data.items || data.assets || data.parts || []),
          ];
      for (const item of items) {
        let manifest = {};
        if (item.manifest) {
          try {
            manifest = JSON.parse(
              await fs.readFile(path.resolve(root, item.manifest), "utf8"),
            );
          } catch {}
        }
        const files =
          item.files ||
          item.artifacts ||
          manifest.files ||
          manifest.artifacts ||
          {};
        const source = typeof item.source === "object" ? item.source : {};
        const candidate =
          item.browserModelPath ||
          item.modelUrl ||
          item.previewPath ||
          item.glb ||
          files.glb ||
          files["model.glb"] ||
          (item.manifest
            ? path.join(path.dirname(item.manifest), "model.glb")
            : undefined) ||
          item.mesh ||
          files.mesh ||
          item.stl ||
          files.stl ||
          item.localPath ||
          item.path;
        const modelPath =
          typeof candidate === "object" ? candidate.path : candidate;
        const normalized = {
          ...item,
          id: item.id || item.sku,
          displayCode: item.displayCode || assetCodes[item.id || item.sku] || item.id || item.sku,
          name: item.name || item.title || item.id,
          category:
            item.category ||
            (item.instance_count ? "装配与工装" : "参数化零件"),
          hero: item.hero || Boolean(item.instance_count),
          instances: item.instance_count,
          format: item.format || "STEP",
          summary:
            item.summary ||
            (item.instance_count
              ? `${item.instance_count} 个部件实例，包含装配关系与拆解检查记录。`
              : "由特征参数与 CAD 工具构建的原创几何。"),
          useCase:
            item.useCase ||
            (item.instance_count
              ? "装配结构研究与分步拆解"
              : "参数建模与几何验证"),
          modelUrl: publicAssetPath(root, modelPath),
          thumbnailUrl: publicAssetPath(
            root,
            item.thumbnailUrl || item.thumbnail || files.thumbnail,
          ),
          manifestUrl: publicAssetPath(
            root,
            item.manifestUrl || item.browserManifestPath || item.manifest,
          ),
          sourceModelUrl: publicAssetPath(
            root,
            item.localPath || files.step || modelPath,
          ),
          stepUrl: publicAssetPath(
            root,
            item.stepUrl ||
              item.step ||
              files.step ||
              (/\.(step|stp)$/i.test(item.localPath || "")
                ? item.localPath
                : undefined) ||
              (/\.(step|stp)$/i.test(modelPath || "") ? modelPath : undefined),
          ),
          sourceUrl: item.sourceUrl || source.url,
          license:
            (typeof item.license === "object"
              ? item.license.id || item.license.name
              : item.license) ||
            item.provenance?.license ||
            data.provenance?.license,
          sourceType:
            item.sourceType ||
            item.source_type ||
            (name.includes("generated") ? "原创参数化" : "开源工程资产"),
          material: item.material || null,
        };
        if (normalized.id) results.push(normalized);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error("Catalog read:", name, error.message);
    }
  }
  return [...new Map(results.map((x) => [x.id, x])).values()];
}
