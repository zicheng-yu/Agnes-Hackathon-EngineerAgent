import { useEffect, useId, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  RotateCcw,
  Maximize,
  Minimize,
  Layers3,
  Box,
  ScanLine,
  LoaderCircle,
} from "lucide-react";
import { loadModel, frame, studio, disposeGroup } from "./three-utils";
import {useTheme, type Theme} from "./Theme";
import { cleanupSafely, readAssemblyPlan, STATIC_MODEL_FALLBACK } from "./viewer-support";

type MeshView = {
  mesh: THREE.Mesh;
  base: THREE.Vector3;
  direction: THREE.Vector3;
  instanceId?: string;
  partId?: string;
};
const noop = () => {};

export default function Viewer({
  url,
  name,
  manifestUrl,
  highlight,
  onParts,
  fallbackImageUrl,
  downloadUrl,
}: {
  url?: string;
  name: string;
  manifestUrl?: string;
  highlight?: string;
  onParts?: (n: number) => void;
  fallbackImageUrl?: string;
  downloadUrl?: string;
}) {
  const {theme} = useTheme();
  const themeRef = useRef(theme);
  const updateAppearance = useRef<(value: Theme) => void>(noop);
  const redraw = useRef<() => void>(noop);
  useEffect(() => {themeRef.current = theme; updateAppearance.current(theme);}, [theme]);
  const shell = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(noop),
    fitVisible = useRef<() => void>(noop);
  const failPreview = useRef<(message: string) => void>(noop),
    onPartsRef = useRef(onParts);
  const data = useRef<{
    meshes: MeshView[];
    radius: number;
    planned: boolean;
    steps: string[];
  } | null>(null);
  const sliderId = useId();
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const [error, setError] = useState(""),
    [warning, setWarning] = useState("");
  const [attempt, setAttempt] = useState(0),
    [fallbackFailed, setFallbackFailed] = useState(false);
  const [explode, setExplode] = useState(0),
    [wire, setWire] = useState(false);
  const [count, setCount] = useState(0),
    [planned, setPlanned] = useState(false);
  const [pathPassed, setPathPassed] = useState<boolean | null>(null);
  const [fullscreen, setFullscreen] = useState(false),
    [fullscreenBusy, setFullscreenBusy] = useState(false);
  const [fullscreenNotice, setFullscreenNotice] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    onPartsRef.current = onParts;
  }, [onParts]);
  useEffect(() => {
    mounted.current = true;
    const sync = () => {
      setFullscreen(document.fullscreenElement === shell.current);
      setFullscreenBusy(false);
    };
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", sync);
    };
  }, []);
  useEffect(() => {
    setFallbackFailed(false);
  }, [fallbackImageUrl, url]);

  useEffect(() => {
    setBusy(Boolean(url));
    setReady(false);
    setError("");
    setWarning("");
    setExplode(0);
    setWire(false);
    setCount(0);
    setPlanned(false);
    setPathPassed(null);
    data.current = null;
    updateAppearance.current = noop;
    reset.current = noop;
    fitVisible.current = noop;
    failPreview.current = noop;
    if (!host.current || !url) return;
    const element = host.current;
    let disposed = false,
      failed = false,
      released = false;
    let model: THREE.Group | undefined, renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined, observer: ResizeObserver | undefined;
    let cleanStudio: (() => void) | undefined, resizeListener: (() => void) | undefined;
    let contextListener: ((event: Event) => void) | undefined;
    let stopRendering: (() => void) | undefined;
    const extras: THREE.Object3D[] = [],
      originalMaterials = new Set<THREE.Material>();
    const manifestAbort = new AbortController();
    let manifestTimer: ReturnType<typeof setTimeout> | undefined;
    let modelTimer: ReturnType<typeof setTimeout> | undefined;

    const release = () => {
      if (released) return;
      released = true;
      data.current = null;
      updateAppearance.current = noop;
      redraw.current = noop;
      reset.current = noop;
      fitVisible.current = noop;
      cleanupSafely(
        stopRendering,
        () => renderer?.setAnimationLoop(null),
        () => manifestAbort.abort(),
        () => {
          if (manifestTimer !== undefined) clearTimeout(manifestTimer);
        },
        () => {
          if (modelTimer !== undefined) clearTimeout(modelTimer);
        },
        () => observer?.disconnect(),
        () => {
          if (resizeListener) window.removeEventListener("resize", resizeListener);
        },
        () => {
          if (contextListener)
            renderer?.domElement.removeEventListener("webglcontextlost", contextListener);
        },
        () => controls?.dispose(),
        cleanStudio,
        () => {
          if (model) disposeGroup(model);
        },
        ...extras.map((item) => () => disposeGroup(item)),
        ...[...originalMaterials].map((material) => () => material.dispose()),
        () => renderer?.dispose(),
        () => renderer?.forceContextLoss?.(),
        () => renderer?.domElement.remove(),
      );
      model = undefined;
    };
    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true;
      release();
      setBusy(false);
      setReady(false);
      setCount(0);
      setPlanned(false);
      setPathPassed(null);
      setError(message);
    };
    failPreview.current = fail;
    const guard = (action: () => void, message: string) => {
      if (disposed || failed) return;
      try {
        action();
      } catch {
        fail(message);
      }
    };

    try {
      const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer = webgl;
      webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      webgl.toneMapping = THREE.ACESFilmicToneMapping;
      webgl.toneMappingExposure = 0.9;
      element.appendChild(webgl.domElement);
      contextListener = (event) => {
        event.preventDefault();
        fail("浏览器中断了 WebGL 绘图。已切换静态预览，可重试三维或下载模型。");
      };
      webgl.domElement.addEventListener("webglcontextlost", contextListener);
      const scene = new THREE.Scene(),
        camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
      cleanStudio = studio(webgl, scene);
      // CAD assets are Z-up. OrbitControls captures camera.up when constructed, so set it
      // first; otherwise dragging orbits around Y and the part tumbles instead of turning.
      camera.up.set(0, 0, 1);
      const orbit = new OrbitControls(camera, webgl.domElement);
      controls = orbit;
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.09;
      orbit.rotateSpeed = 0.8;
      orbit.zoomToCursor = true;
      let animating = false, settling = 0;
      const draw = () => {
        if (disposed || failed || document.hidden) return;
        settling = 2;
        if (!animating) { animating = true; webgl.setAnimationLoop(renderFrame); }
      };
      const renderFrame = () => guard(() => {
        if (document.hidden) { webgl.setAnimationLoop(null); animating = false; return; }
        const changed = orbit.update();
        webgl.render(scene, camera);
        if (!changed && --settling <= 0) { webgl.setAnimationLoop(null); animating = false; }
      }, '三维绘图发生错误，已切换静态预览。其他工作区仍可使用。');
      const visibility = () => { if (document.hidden) { webgl.setAnimationLoop(null); animating = false; } else draw(); };
      orbit.addEventListener('change', draw);
      document.addEventListener('visibilitychange', visibility);
      redraw.current = draw;
      stopRendering = () => { orbit.removeEventListener('change', draw); document.removeEventListener('visibilitychange', visibility); };
      const resize = () =>
        guard(() => {
          const w = element.clientWidth,
            h = element.clientHeight;
          if (w <= 0 || h <= 0) return;
          webgl.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          draw();
        }, "三维预览无法适应当前窗口，已切换静态预览。");
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(resize);
        observer.observe(element);
      } else {
        resizeListener = resize;
        window.addEventListener("resize", resize);
      }
      resize();
      if (!failed) draw();
      if (!failed) {
        modelTimer = setTimeout(
          () => fail("模型读取超时。可先查看静态预览或下载文件，再重试三维。"),
          20000,
        );
        manifestTimer = setTimeout(() => manifestAbort.abort(), 10000);
        const manifestPromise = manifestUrl
          ? fetch(manifestUrl, { signal: manifestAbort.signal })
              .then(async (response) => {
                if (!response.ok) throw new Error("manifest unavailable");
                const value = await response.json();
                if (!value || typeof value !== "object" || Array.isArray(value))
                  throw new Error("manifest invalid");
                return { value, notice: "" };
              })
              .catch(() => ({
                value: null,
                notice: "装配与校验资料暂不可用；仅展示几何，不表示拆解路径已通过校验。",
              }))
          : Promise.resolve({ value: null, notice: "" });
        // Track a loaded group immediately, even while the separate manifest request is pending.
        Promise.resolve()
          .then(() => loadModel(url))
          .then(async (group) => {
            if (modelTimer !== undefined) clearTimeout(modelTimer);
            if (disposed || failed) {
              cleanupSafely(() => disposeGroup(group));
              return;
            }
            model = group;
            const { value: manifest, notice } = await manifestPromise;
            if (manifestTimer !== undefined) clearTimeout(manifestTimer);
            if (disposed || failed) return;
            scene.add(group);
            const radius = frame(group, camera),
              plan = readAssemblyPlan(manifest);
            const instanceMap = new Map(
              plan.instances.map((instance) => [instance.id, instance]),
            );
            const meshObjects: THREE.Mesh[] = [];
            group.traverse((obj) => {
              if (obj instanceof THREE.Mesh) meshObjects.push(obj);
            });
            if (!meshObjects.length) throw new Error("模型中没有可显示的几何");
            const matchInstance = (mesh: THREE.Object3D) => {
              let current: THREE.Object3D | null = mesh;
              while (current && current !== group) {
                const instance = instanceMap.get(current.name);
                if (instance) return instance;
                current = current.parent;
              }
              return undefined;
            };
            const matched = new Set(
              meshObjects.map((mesh) => matchInstance(mesh)?.id).filter(Boolean),
            );
            const hasPlan =
              plan.instances.length > 0 &&
              matched.size === plan.instances.length &&
              meshObjects.every((mesh) => matchInstance(mesh));
            const materialColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
            const meshes: MeshView[] = meshObjects.map((obj) => {
              const instance = hasPlan ? matchInstance(obj) : undefined;
              const center = new THREE.Box3()
                .setFromObject(obj)
                .getCenter(new THREE.Vector3());
              const direction = hasPlan
                ? new THREE.Vector3(...instance!.explode)
                : center.length() > 0.001
                  ? center.normalize()
                  : new THREE.Vector3(0, 0, 1);
              if (obj.parent)
                direction.applyQuaternion(
                  obj.parent.getWorldQuaternion(new THREE.Quaternion()).invert(),
                );
              for (const material of Array.isArray(obj.material)
                ? obj.material
                : [obj.material])
                originalMaterials.add(material);
              obj.material = Array.isArray(obj.material)
                ? obj.material.map((material) => material.clone())
                : obj.material.clone();
              for (const material of Array.isArray(obj.material)
                ? obj.material
                : [obj.material])
                if (material instanceof THREE.MeshStandardMaterial) {
                  materialColors.set(material, material.color.clone());
                  material.metalness = 0.55;
                  material.roughness = 0.32;
                }
              return {
                mesh: obj,
                base: obj.position.clone(),
                direction,
                instanceId: instance?.id,
                partId: instance?.part_id,
              };
            });
            data.current = {
              meshes,
              radius,
              planned: hasPlan,
              steps: hasPlan ? plan.steps : [],
            };
            const grid = new THREE.GridHelper(radius * 2.6, 20, 0xaab2b0, 0xd2d7d4);
            extras.push(grid);
            grid.rotation.x = Math.PI / 2;
            grid.position.z = new THREE.Box3().setFromObject(group).min.z - radius * 0.05;
            scene.add(grid);
            updateAppearance.current = (next) => guard(() => {
              for (const [material, baseColor] of materialColors)
                material.color.copy(baseColor).multiplyScalar(next === "light" ? 0.68 : 1);
              for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
                material.transparent = true;
                material.opacity = next === "light" ? 0.75 : 0.24;
              }
              draw();
            }, "三维显示更新失败，已切换静态预览。");
            updateAppearance.current(themeRef.current);
            const axes = new THREE.AxesHelper(radius * 0.26);
            extras.push(axes);
            axes.position.set(-radius * 0.7, -radius * 0.6, grid.position.z);
            scene.add(axes);
            orbit.target.set(0, 0, 0);
            orbit.update();
            fitVisible.current = () =>
              guard(() => {
                const sphere = new THREE.Box3()
                  .setFromObject(group)
                  .getBoundingSphere(new THREE.Sphere());
                if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
                const direction = camera.position.clone().sub(orbit.target).normalize();
                if (direction.lengthSq() === 0) direction.set(1, -1, 1).normalize();
                const vertical = THREE.MathUtils.degToRad(camera.fov),
                  horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
                const distance =
                  (sphere.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.06;
                orbit.target.copy(sphere.center);
                camera.position.copy(sphere.center).addScaledVector(direction, distance);
                orbit.update();
              }, "三维视角调整失败，已切换静态预览。");
            const original = camera.position.clone();
            reset.current = () =>
              guard(() => {
                camera.position.copy(original);
                orbit.target.set(0, 0, 0);
                orbit.update();
                setExplode(0);
              }, "三维视角复位失败，已切换静态预览。");
            setCount(meshes.length);
            onPartsRef.current?.(meshes.length);
            setPlanned(hasPlan);
            setPathPassed(hasPlan ? plan.pathPassed : null);
            setWarning(
              notice ||
                (manifest?.operation === "assembly" && !hasPlan
                  ? "装配资料与模型部件无法完整对应；当前展开仅为位移示意，未确认拆解路径。"
                  : ""),
            );
            setBusy(false);
            setReady(true);
            draw();
          })
          .catch(() =>
            fail("模型资源或三维场景加载失败。可查看静态预览、下载文件，或重试三维。"),
          );
      }
    } catch {
      fail(
        "当前浏览器无法启用 WebGL 三维绘图。可启用硬件加速后重试，也可使用静态预览和模型下载。",
      );
    }
    return () => {
      disposed = true;
      release();
      failPreview.current = noop;
    };
  }, [url, manifestUrl, attempt]);

  useEffect(() => {
    const d = data.current;
    if (!d) return;
    try {
      for (const { mesh, base, direction, instanceId } of d.meshes) {
        const index = d.steps.indexOf(instanceId || "");
        const amount = d.planned
          ? index < 0
            ? 0
            : Math.min(1, Math.max(0, (explode / 100) * d.steps.length - index))
          : d.radius * explode * 0.012;
        mesh.position.copy(base).addScaledVector(direction, amount);
      }
      fitVisible.current();
      redraw.current();
    } catch {
      failPreview.current("三维展开绘制失败，已切换静态预览。");
    }
  }, [explode]);
  useEffect(() => {
    if (!data.current) return;
    try {
      for (const { mesh } of data.current.meshes)
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          if ("wireframe" in material)
            (material as THREE.MeshStandardMaterial).wireframe = wire;
      redraw.current();
    } catch {
      failPreview.current("三维材质显示失败，已切换静态预览。");
    }
  }, [wire]);
  useEffect(() => {
    if (!data.current) return;
    try {
      for (const { mesh, partId } of data.current.meshes)
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          if ("emissive" in material) {
            const m = material as THREE.MeshStandardMaterial;
            m.emissive.set(partId === highlight ? 0xf27743 : 0x000000);
            m.emissiveIntensity = partId === highlight ? 0.35 : 0;
          }
      redraw.current();
    } catch {
      failPreview.current("三维部件高亮失败，已切换静态预览。");
    }
  }, [highlight, count]);

  const toggleFullscreen = async () => {
    const element = shell.current;
    if (!element) return;
    setFullscreenNotice("");
    const exiting = document.fullscreenElement === element;
    if (
      (!exiting &&
        (document.fullscreenEnabled === false ||
          typeof element.requestFullscreen !== "function")) ||
      (exiting && typeof document.exitFullscreen !== "function")
    ) {
      setFullscreenNotice("此浏览器暂不支持全屏，可继续在当前窗口查看。");
      return;
    }
    setFullscreenBusy(true);
    try {
      if (exiting) await document.exitFullscreen();
      else await element.requestFullscreen();
      if (mounted.current) setFullscreen(document.fullscreenElement === shell.current);
    } catch {
      if (mounted.current) setFullscreenNotice("浏览器未允许切换全屏，可继续在当前窗口查看。");
    } finally {
      if (mounted.current) setFullscreenBusy(false);
    }
  };
  const staticImage =
    fallbackImageUrl && !fallbackFailed ? fallbackImageUrl : STATIC_MODEL_FALLBACK;
  return (
    <div className="viewer-shell" ref={shell}>
      <div className="viewer-top">
        <span>
          <Box size={14} /> {name}
        </span>
      </div>
      <div className="viewer-stage">
        <div className="viewer-canvas" ref={host} aria-hidden="true" />
        {!url && (
          <div className="viewer-state">
            <Box size={36} />
            <strong>选择一个模型</strong>
            <span>查看几何结构与装配层级</span>
          </div>
        )}
        {busy && (
          <div className="viewer-state" role="status">
            <LoaderCircle className="spin" size={28} />
            <span>正在读取三维几何…</span>
          </div>
        )}
        {error && (
          <div className="viewer-fallback" role="status">
            <img
              src={staticImage}
              alt={
                fallbackImageUrl && !fallbackFailed
                  ? `${name}的静态预览（非交互）`
                  : "三维预览不可用的静态占位示意"
              }
              onError={() => setFallbackFailed(true)}
            />
            <div className="viewer-fallback-copy">
              <ScanLine size={22} />
              <strong>三维预览暂不可用</strong>
              <p>{error}</p>
              <p>静态图片不代表模型或拆解校验已通过，其他工作区可继续使用。</p>
            </div>
            <div className="viewer-fallback-actions">
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                重试三维预览
              </button>
              {(downloadUrl || url) && (
                <a href={downloadUrl || url} download>
                  下载模型
                </a>
              )}
            </div>
          </div>
        )}
        <div className="view-tools">
          <button
            type="button"
            title="复位视角"
            aria-label="复位视角"
            disabled={!ready}
            onClick={() => reset.current()}
          >
            <RotateCcw size={17} />
          </button>
          <button
            type="button"
            title="线框"
            aria-label="切换线框"
            aria-pressed={wire}
            disabled={!ready}
            className={wire ? "active" : ""}
            onClick={() => setWire((value) => !value)}
          >
            <Box size={17} />
          </button>
          <button
            type="button"
            title={fullscreen ? "退出全屏" : "全屏查看"}
            aria-label={fullscreen ? "退出全屏" : "全屏查看"}
            aria-pressed={fullscreen}
            disabled={fullscreenBusy}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
        </div>
      </div>
      {(warning || fullscreenNotice) && (
        <div className="viewer-notice" role="status">
          {[warning, fullscreenNotice].filter(Boolean).join(" ")}
        </div>
      )}
      <div className="viewer-bottom">
        <div className="viewer-bottom-meta">
          <Layers3 size={15} />
          <span>{planned ? "顺序拆解" : "空间展开"}</span>
          <small>
            {!ready
              ? url
                ? "预览未就绪 · 未确认校验状态"
                : "等待模型"
              : planned
                ? `${count} 实例 · ${pathPassed === true ? "采样路径通过" : pathPassed === false ? "路径校验未通过" : "路径校验资料未确认"}`
                : count > 1
                  ? `${count} 个几何单元 · 位移示意`
                  : "单体模型"}
          </small>
        </div>
        <div className="viewer-explode-control">
          <label htmlFor={sliderId}>{planned ? "拆解进度" : "展开程度"}</label>
          <input
            id={sliderId}
            aria-label="空间展开程度"
            type="range"
            min="0"
            max="100"
            disabled={!ready || count < 2}
            value={explode}
            onChange={(e) => setExplode(Number(e.target.value))}
          />
          <output className="mono" htmlFor={sliderId}>
            {explode}%
          </output>
        </div>
      </div>
    </div>
  );
}
