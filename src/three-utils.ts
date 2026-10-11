import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { cleanupSafely, STATIC_MODEL_FALLBACK } from "./viewer-support";

export const steel = () =>
  new THREE.MeshStandardMaterial({
    color: 0xa8b4ba,
    metalness: 0.7,
    roughness: 0.3,
  });
export async function loadModel(url: string): Promise<THREE.Group> {
  const result = new THREE.Group();
  let pendingGeometry: THREE.BufferGeometry | undefined;
  try {
    if (/\.gl(b|tf)(\?|$)/i.test(url))
      result.add((await new GLTFLoader().loadAsync(url)).scene);
    else if (/\.stl(\?|$)/i.test(url)) {
      const geometry = await new STLLoader().loadAsync(url);
      pendingGeometry = geometry;
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, steel());
      mesh.name = "实体";
      result.add(mesh);
      pendingGeometry = undefined;
    } else if (/\.json(\?|$)/i.test(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`模型资源读取失败（HTTP ${response.status}）`);
      const data = await response.json();
      const entries = data.parts || data.meshes || (data.positions ? [data] : []);
      for (const item of (Array.isArray(entries)
        ? entries
        : Object.values(entries)) as any[]) {
        const geometry = new THREE.BufferGeometry();
        pendingGeometry = geometry;
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(item.positions.flat(), 3),
        );
        if (item.indices) geometry.setIndex(item.indices.flat());
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, steel());
        mesh.name = item.id || item.name || "实体";
        result.add(mesh);
        pendingGeometry = undefined;
      }
    } else throw new Error("此资产需要先转换为浏览器可显示的模型");
    result.updateMatrixWorld(true);
    return result;
  } catch (error) {
    cleanupSafely(
      () => pendingGeometry?.dispose(),
      () => disposeGroup(result),
    );
    throw error;
  }
}
export function disposeGroup(group: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse((obj) => {
    const renderable = obj as THREE.Mesh;
    if (renderable.geometry) geometries.add(renderable.geometry);
    const owned = renderable.material;
    for (const material of owned ? (Array.isArray(owned) ? owned : [owned]) : []) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  cleanupSafely(
    ...[...textures].map((item) => () => item.dispose()),
    ...[...materials].map((item) => () => item.dispose()),
    ...[...geometries].map((item) => () => item.dispose()),
  );
}
export function studio(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  let pmrem: THREE.PMREMGenerator | undefined;
  let environment: RoomEnvironment | undefined;
  let target: THREE.WebGLRenderTarget | undefined;
  const lights: THREE.Light[] = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupSafely(
      () => {
        if (scene.environment === target?.texture) scene.environment = null;
      },
      () => target?.dispose(),
      () => pmrem?.dispose(),
      () => environment?.dispose(),
      ...lights.map((light) => () => scene.remove(light)),
    );
  };
  try {
    pmrem = new THREE.PMREMGenerator(renderer);
    environment = new RoomEnvironment();
    target = pmrem.fromScene(environment, 0.04);
    scene.environment = target.texture;
    const hemisphere = new THREE.HemisphereLight(0xdfeaf1, 0x30383b, 2);
    lights.push(hemisphere);
    scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffffff, 3);
    lights.push(key);
    key.position.set(2, -4, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc6dded, 2);
    lights.push(rim);
    rim.position.set(-3, 2, 3);
    scene.add(rim);
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
export function frame(group: THREE.Object3D, camera: THREE.PerspectiveCamera) {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) throw new Error("模型中没有可显示的几何");
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  group.position.sub(center);
  group.updateMatrixWorld(true);
  const radius = Math.max(size.x, size.y, size.z, 0.01);
  if (!Number.isFinite(radius)) throw new Error("模型尺寸不是有效数值");
  camera.up.set(0, 0, 1);
  camera.near = radius / 1000;
  camera.far = radius * 100;
  camera.position.set(radius * 1.25, -radius * 1.55, radius * 1.08);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  return radius;
}
let queue = Promise.resolve();
const thumbnails = new Map<string, Promise<string>>();
let thumbRenderer: THREE.WebGLRenderer | undefined;
let thumbnailGpuFailed = false;
const cancelThumbnailLoads = new Set<() => void>();
function disableThumbnailGpu() {
  thumbnailGpuFailed = true;
  for (const cancel of cancelThumbnailLoads) cancel();
  const renderer = thumbRenderer;
  thumbRenderer = undefined;
  cleanupSafely(
    () => renderer?.setAnimationLoop(null),
    () => renderer?.dispose(),
    () => renderer?.forceContextLoss?.(),
  );
}
function lostContext(renderer: THREE.WebGLRenderer) {
  try {
    return renderer.getContext?.()?.isContextLost?.() === true;
  } catch {
    return true;
  }
}
export function thumbnail(
  url: string,
  fallbackImageUrl = STATIC_MODEL_FALLBACK,
): Promise<string> {
  if (thumbnailGpuFailed) return Promise.resolve(fallbackImageUrl);
  const key = `${url}\n${fallbackImageUrl}`;
  if (thumbnails.has(key)) return thumbnails.get(key)!;
  const promise = queue
    .catch(() => {})
    .then(async () => {
      if (thumbnailGpuFailed) return fallbackImageUrl;
      let model: THREE.Group | undefined;
      let cleanup: undefined | (() => void);
      let gpuOperation = true;
      let abandoned = false;
      let cancelLoad: (() => void) | undefined;
      let loadTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!thumbRenderer) {
          thumbRenderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true,
          });
          thumbRenderer.domElement.addEventListener(
            "webglcontextlost",
            (event) => {
              event.preventDefault();
              disableThumbnailGpu();
            },
            { once: true },
          );
        }
        const renderer = thumbRenderer;
        thumbRenderer.setSize(480, 320);
        thumbRenderer.setPixelRatio(1);
        thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
        thumbRenderer.toneMappingExposure = 1.2;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, 1.5, 0.01, 1000);
        cleanup = studio(thumbRenderer, scene);
        gpuOperation = false;
        const cancellation = new Promise<null>((resolve) => {
          cancelLoad = () => resolve(null);
          cancelThumbnailLoads.add(cancelLoad);
          loadTimer = setTimeout(cancelLoad, 15000);
        });
        const loading = loadModel(url).then((group) => {
          if (abandoned || thumbnailGpuFailed) {
            cleanupSafely(() => disposeGroup(group));
            return null;
          }
          return group;
        });
        const loaded = await Promise.race([loading, cancellation]);
        if (!loaded) {
          abandoned = true;
          return fallbackImageUrl;
        }
        model = loaded;
        if (thumbnailGpuFailed || thumbRenderer !== renderer) return fallbackImageUrl;
        if (lostContext(renderer)) {
          disableThumbnailGpu();
          return fallbackImageUrl;
        }
        scene.add(model);
        frame(model, camera);
        gpuOperation = true;
        renderer.render(scene, camera);
        if (thumbnailGpuFailed || lostContext(renderer)) {
          disableThumbnailGpu();
          return fallbackImageUrl;
        }
        return renderer.domElement.toDataURL("image/png");
      } catch {
        // One asset failing to load must not disable all other valid assets.
        if (gpuOperation) disableThumbnailGpu();
        return fallbackImageUrl;
      } finally {
        abandoned = true;
        if (cancelLoad) cancelThumbnailLoads.delete(cancelLoad);
        if (loadTimer !== undefined) clearTimeout(loadTimer);
        cleanupSafely(model ? () => disposeGroup(model!) : undefined, cleanup);
      }
    });
  queue = promise.then(
    () => {},
    () => {},
  );
  thumbnails.set(key, promise);
  return promise;
}
