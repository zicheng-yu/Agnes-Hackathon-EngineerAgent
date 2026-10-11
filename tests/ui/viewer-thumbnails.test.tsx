import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

const mocks = vi.hoisted(() => ({
  fail: "",
  renderers: [] as any[],
  constructions: 0,
  load: vi.fn(),
  pmremDispose: vi.fn(),
  environmentDispose: vi.fn(),
  targetDispose: vi.fn(),
}));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      setSize = vi.fn();
      setPixelRatio = vi.fn();
      setAnimationLoop = vi.fn();
      dispose = vi.fn();
      forceContextLoss = vi.fn();
      getContext = () => ({ isContextLost: () => mocks.fail === "silent-context-loss" });
      render = vi.fn(() => {
        if (mocks.fail === "render") throw new Error("GPU render failed");
      });
      constructor() {
        mocks.constructions += 1;
        if (mocks.fail === "constructor") throw new Error("WebGL disabled");
        this.domElement.toDataURL = vi.fn(() => "data:image/png;base64,rendered");
        mocks.renderers.push(this);
      }
    },
    PMREMGenerator: class {
      dispose = mocks.pmremDispose;
      fromScene() {
        if (mocks.fail === "studio") throw new Error("environment failed");
        return { texture: new actual.Texture(), dispose: mocks.targetDispose };
      }
    },
  };
});
vi.mock("three/addons/environments/RoomEnvironment.js", () => ({
  RoomEnvironment: class {
    dispose = mocks.environmentDispose;
  },
}));
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    loadAsync = mocks.load;
  },
}));

function group() {
  const result = new THREE.Group();
  result.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  mocks.fail = "";
  mocks.constructions = 0;
  mocks.renderers.length = 0;
  mocks.load.mockReset().mockImplementation(async () => ({ scene: group() }));
  mocks.pmremDispose.mockReset();
  mocks.environmentDispose.mockReset();
  mocks.targetDispose.mockReset();
});

describe("thumbnail circuit breaker", () => {
  it.each(["constructor", "studio", "render", "silent-context-loss"])(
    "%s failure falls back once for an entire queued batch",
    async (stage) => {
      mocks.fail = stage;
      const { thumbnail } = await import("../../src/three-utils");
      const images = await Promise.all(
        Array.from({ length: 24 }, (_, i) => thumbnail(`/part-${i}.glb`, `/static-${i}.png`)),
      );
      expect(images).toEqual(Array.from({ length: 24 }, (_, i) => `/static-${i}.png`));
      expect(mocks.constructions).toBe(1);
      expect(await thumbnail("/another.glb", "/another.png")).toBe("/another.png");
      expect(mocks.constructions).toBe(1);
      if (stage === "studio") {
        expect(mocks.pmremDispose).toHaveBeenCalledOnce();
        expect(mocks.environmentDispose).toHaveBeenCalledOnce();
      }
    },
  );

  it("an unavailable model does not break rendering for other assets", async () => {
    mocks.load.mockRejectedValueOnce(new Error("404"));
    const { thumbnail } = await import("../../src/three-utils");
    expect(await thumbnail("/missing.glb", "/fallback.png")).toBe("/fallback.png");
    expect(await thumbnail("/valid.glb")).toBe("data:image/png;base64,rendered");
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.constructions).toBe(1);
  });

  it("context loss releases a hanging load and its queue, and disposes late geometry", async () => {
    const pending = deferred<{ scene: THREE.Group }>();
    mocks.load.mockReturnValueOnce(pending.promise);
    const { thumbnail } = await import("../../src/three-utils");
    const first = thumbnail("/slow.glb", "/slow.png"),
      next = thumbnail("/queued.glb", "/queued.png");
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    mocks.renderers[0].domElement.dispatchEvent(
      new Event("webglcontextlost", { cancelable: true }),
    );
    expect(await first).toBe("/slow.png");
    expect(await next).toBe("/queued.png");
    const late = group(),
      geometry = (late.children[0] as THREE.Mesh).geometry;
    const disposed = vi.spyOn(geometry, "dispose");
    pending.resolve({ scene: late });
    await vi.waitFor(() => expect(disposed).toHaveBeenCalled());
    expect(mocks.constructions).toBe(1);
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("cleanup failures do not poison the next queued thumbnail", async () => {
    mocks.targetDispose.mockImplementationOnce(() => {
      throw new Error("teardown driver error");
    });
    const { thumbnail } = await import("../../src/three-utils");
    expect(await thumbnail("/one.glb")).toBe("data:image/png;base64,rendered");
    expect(await thumbnail("/two.glb")).toBe("data:image/png;base64,rendered");
    expect(mocks.environmentDispose).toHaveBeenCalledTimes(2);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
});
