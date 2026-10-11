import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import Viewer from "../../src/Viewer";

const mocks = vi.hoisted(() => ({
  fail: "",
  renderers: [] as any[],
  controls: [] as any[],
  observers: [] as any[],
  load: vi.fn(),
  frame: vi.fn(),
  studio: vi.fn(),
  disposeGroup: vi.fn(),
  cleanStudio: vi.fn(),
}));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      loop: (() => void) | null = null;
      setPixelRatio = vi.fn();
      setSize = vi.fn(() => {
        if (mocks.fail === "resize") throw new Error("resize failed");
      });
      setAnimationLoop = vi.fn((callback) => {
        this.loop = callback;
      });
      render = vi.fn(() => {
        if (mocks.fail === "render") throw new Error("render failed");
      });
      dispose = vi.fn();
      forceContextLoss = vi.fn();
      constructor() {
        if (mocks.fail === "constructor") throw new Error("WebGL disabled");
        mocks.renderers.push(this);
      }
    },
  };
});
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  return {
    OrbitControls: class extends actual.EventDispatcher {
      target = new actual.Vector3();
      update = vi.fn();
      dispose = vi.fn();
      constructor() {
        super();
        if (mocks.fail === "controls") throw new Error("controls failed");
        mocks.controls.push(this);
      }
    },
  };
});
vi.mock("../../src/three-utils", () => ({
  loadModel: mocks.load,
  frame: mocks.frame,
  studio: mocks.studio,
  disposeGroup: mocks.disposeGroup,
}));

function cubeGroup(names = ["part"]) {
  const group = new THREE.Group();
  for (const name of names) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial(),
    );
    mesh.name = name;
    group.add(mesh);
  }
  return group;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fullscreenElement(value: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value });
  document.dispatchEvent(new Event("fullscreenchange"));
}

beforeEach(() => {
  mocks.fail = "";
  mocks.renderers.length = 0;
  mocks.controls.length = 0;
  mocks.observers.length = 0;
  mocks.load.mockReset().mockImplementation(async () => cubeGroup());
  mocks.disposeGroup.mockReset();
  mocks.cleanStudio.mockReset();
  mocks.frame.mockReset().mockImplementation((_group, camera) => {
    if (mocks.fail === "frame") throw new Error("frame failed");
    camera.position.set(1, -1, 1);
    return 10;
  });
  mocks.studio.mockReset().mockImplementation(() => {
    if (mocks.fail === "studio") throw new Error("studio failed");
    return mocks.cleanStudio;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(public callback: () => void) {
        mocks.observers.push(this);
      }
    },
  );
  vi.stubGlobal("fetch", vi.fn());
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
    configurable: true,
    value: vi.fn(function (this: Element) {
      fullscreenElement(this);
      return Promise.resolve();
    }),
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: vi.fn(() => {
      fullscreenElement(null);
      return Promise.resolve();
    }),
  });
});
afterEach(() => cleanup());

describe("nonfatal 3D failures", () => {
  it('stops rendering when idle, redraws on controls changes and pauses in hidden tabs', async () => {
    render(<Viewer url="/model.glb" name="零件" />);
    await waitFor(()=>expect(screen.getByRole('button',{name:'复位视角'})).toBeEnabled());
    const renderer=mocks.renderers[0],controls=mocks.controls[0];
    act(()=>{renderer.loop();renderer.loop();});expect(renderer.loop).toBeNull();
    act(()=>controls.dispatchEvent({type:'change'}));expect(renderer.loop).toBeTypeOf('function');
    Object.defineProperty(document,'hidden',{configurable:true,value:true});act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(renderer.loop).toBeNull();
    Object.defineProperty(document,'hidden',{configurable:true,value:false});act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(renderer.loop).toBeTypeOf('function');
  });
  it.each(["constructor", "studio", "controls", "resize", "frame"])(
    "%s failure preserves the rest of the workspace and offers static fallback",
    async (stage) => {
      mocks.fail = stage;
      const outside = vi.fn();
      render(
        <>
          <button onClick={outside}>订单工作区</button>
          <Viewer
            url="/model.glb"
            name="零件"
            fallbackImageUrl="/preview.png"
            downloadUrl="/model.step"
          />
        </>,
      );
      expect(await screen.findByText("三维预览暂不可用")).toBeInTheDocument();
      expect(screen.getByRole("img")).toHaveAttribute("src", "/preview.png");
      expect(screen.getByRole("link", { name: "下载模型" })).toHaveAttribute(
        "href",
        "/model.step",
      );
      expect(screen.getByRole("slider")).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "订单工作区" }));
      expect(outside).toHaveBeenCalledOnce();
      expect(screen.queryByText(/正在读取/)).not.toBeInTheDocument();
      for (const renderer of mocks.renderers) {
        expect(renderer.dispose).toHaveBeenCalled();
        expect(renderer.domElement.isConnected).toBe(false);
      }
    },
  );

  it("catches later render errors and continues teardown even if one disposer throws", async () => {
    const { unmount } = render(<Viewer url="/model.glb" name="零件" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "复位视角" })).toBeEnabled(),
    );
    const renderer = mocks.renderers[0];
    renderer.dispose.mockImplementation(() => {
      throw new Error("driver teardown");
    });
    mocks.controls[0].dispose.mockImplementation(() => {
      throw new Error("controls teardown");
    });
    mocks.fail = "render";
    act(() => renderer.loop());
    expect(screen.getByText("三维预览暂不可用")).toBeInTheDocument();
    expect(mocks.cleanStudio).toHaveBeenCalled();
    expect(mocks.disposeGroup).toHaveBeenCalled();
    expect(renderer.loop).toBeNull();
    expect(renderer.domElement.isConnected).toBe(false);
    expect(() => unmount()).not.toThrow();
  });

  it("does not resurrect a model that finishes after context loss, and explicit retry can recover", async () => {
    const pending = deferred<THREE.Group>(),
      onParts = vi.fn();
    mocks.load.mockReturnValueOnce(pending.promise);
    render(<Viewer url="/model.glb" name="零件" onParts={onParts} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalled());
    const old = mocks.renderers[0];
    act(() =>
      old.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true })),
    );
    const late = cubeGroup();
    await act(async () => pending.resolve(late));
    expect(mocks.disposeGroup).toHaveBeenCalledWith(late);
    expect(onParts).not.toHaveBeenCalled();
    expect(screen.getByText("三维预览暂不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试三维预览" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "复位视角" })).toBeEnabled(),
    );
    expect(onParts).toHaveBeenCalledWith(1);
    expect(mocks.renderers).toHaveLength(2);
  });

  it("releases an already-loaded group when manifest loading is still pending during unmount", async () => {
    const group = cubeGroup();
    mocks.load.mockResolvedValue(group);
    const pending = deferred<Response>();
    (fetch as any).mockReturnValue(pending.promise);
    const { unmount } = render(
      <Viewer url="/model.glb" manifestUrl="/manifest.json" name="零件" />,
    );
    await waitFor(() => expect(mocks.load).toHaveBeenCalled());
    await act(async () => {});
    const signal = (fetch as any).mock.calls[0][1].signal;
    unmount();
    expect(mocks.disposeGroup).toHaveBeenCalledWith(group);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ ok: true, json: async () => ({}) } as Response));
  });

  it("skips zero-height rendering resize and resets stale model state when URL is cleared", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
    const view = render(<Viewer url="/model.glb" name="零件" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "复位视角" })).toBeEnabled(),
    );
    expect(mocks.renderers[0].setSize).not.toHaveBeenCalled();
    view.rerender(<Viewer name="空" />);
    expect(screen.getByText("等待模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复位视角" })).toBeDisabled();
  });

  it("model resource rejection falls back without a passed validation claim", async () => {
    mocks.load.mockRejectedValue(new Error("404"));
    render(<Viewer url="/missing.glb" name="缺少模型" />);
    expect(await screen.findByText("三维预览暂不可用")).toBeInTheDocument();
    expect(screen.queryByText(/采样路径通过/)).not.toBeInTheDocument();
  });
});

describe("manifest and sequential movement", () => {
  const manifest = () => ({
    operation: "assembly",
    instances: [
      { id: "first", part_id: "a", sequence: 1, explode: [10, 0, 0] },
      { id: "second", part_id: "b", sequence: 2, explode: [0, 20, 0] },
    ],
    path_check: {
      passed: true,
      steps: [
        { instance_id: "first", checked: true, passed: true },
        { instance_id: "second", checked: true, passed: true },
      ],
    },
    verification: { path_check_passed: true },
  });
  it("retains checked-step order and amount while accurately resetting the assembly", async () => {
    const group = cubeGroup(["first", "second"]);
    mocks.load.mockResolvedValue(group);
    (fetch as any).mockResolvedValue({ ok: true, json: async () => manifest() });
    render(<Viewer url="/assembly.glb" manifestUrl="/manifest.json" name="装配" />);
    expect(await screen.findByText(/2 实例 · 采样路径通过/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "50" } });
    expect(group.children[0].position.x).toBe(10);
    expect(group.children[1].position.y).toBe(0);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "100" } });
    expect(group.children[1].position.y).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "复位视角" }));
    expect(group.children[0].position.x).toBe(0);
    expect(group.children[1].position.y).toBe(0);
  });
  it.each([
    "http",
    "string",
    "mismatch",
    "conflict",
    "incomplete",
    "duplicate",
    "summary-string",
    "count-mismatch",
    "collision",
  ])("never labels %s manifest evidence as passed", async (mode) => {
    mocks.load.mockResolvedValue(
      cubeGroup(mode === "mismatch" ? ["unknown"] : ["first", "second"]),
    );
    const value: any = manifest();
    if (mode === "string") value.path_check.passed = "false";
    if (mode === "conflict") value.verification.path_check_passed = false;
    if (mode === "incomplete") value.path_check.steps.pop();
    if (mode === "duplicate") value.path_check.steps.push(value.path_check.steps[0]);
    if (mode === "summary-string") value.verification.path_check_passed = "false";
    if (mode === "count-mismatch") value.instance_count = 3;
    if (mode === "collision") value.path_check.initial_interferences = [{ collision: true }];
    (fetch as any).mockResolvedValue({ ok: mode !== "http", json: async () => value });
    render(<Viewer url="/assembly.glb" manifestUrl="/manifest.json" name="装配" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "复位视角" })).toBeEnabled(),
    );
    expect(screen.queryByText(/采样路径通过/)).not.toBeInTheDocument();
  });
});

describe("fullscreen state", () => {
  it("toggles entry/exit and follows Esc/fullscreenchange rather than local optimistic state", async () => {
    render(<Viewer name="模型" />);
    fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
    const exit = await screen.findByRole("button", { name: "退出全屏" });
    expect(exit).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(exit);
    await screen.findByRole("button", { name: "全屏查看" });
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
    await screen.findByRole("button", { name: "退出全屏" });
    act(() => fullscreenElement(null));
    expect(screen.getByRole("button", { name: "全屏查看" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    act(() => fullscreenElement(document.createElement("div")));
    expect(screen.getByRole("button", { name: "全屏查看" })).toBeInTheDocument();
  });
  it.each(["unsupported", "rejected"])("%s fullscreen stays nonfatal", async (mode) => {
    if (mode === "unsupported")
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        value: false,
      });
    else
      (HTMLElement.prototype.requestFullscreen as any).mockRejectedValue(
        new Error("not permitted"),
      );
    render(<Viewer name="模型" />);
    fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
    expect(await screen.findByText(/可继续在当前窗口查看/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全屏查看" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
