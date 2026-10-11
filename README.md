# EngineerAgent

面向机加工企业的工程智能体。以官方 **Agnes Harness（AGH）** 为运行底座，默认调用 **Agnes 3.0 Flash**，由 AGH 编排工业工具完成三类任务：

- **图纸重建**：读取零件图或装配图，构建参数化 CAD 模型，逐项实测校验并回投影；装配图生成可拆解的爆炸视图与 BOM。缺尺寸时暂停并请求补充，不猜测。
- **订单评审**：逐行解析采购明细，匹配零件库、分配库存、估算待产工时；冲突或未知编号逐行标出并检索候选件。
- **零件检索**：在 45 条带来源与许可的工程资产中按用途、结构、材料检索，可查看三维模型、拆解视图与部件清单。

每次任务的工具调用实时显示，并可导出 AGH 原生执行记录供复核。

- 在线体验：<https://engineeragent.zichengyu.site/>（无需安装，模型为 MiniMax-M3）
- 开源仓库：<https://github.com/zicheng-yu/Agnes-Hackathon-EngineerAgent>

## 快速启动

三个平台都需要 [Node.js](https://nodejs.org/) ≥ 24.10、[Python](https://www.python.org/downloads/) 3.12 和 [Git](https://git-scm.com/downloads)，另需本平台的 C/C++ 编译工具（用于构建 AGH 的原生模块）。

| 平台 | 额外准备 | 启动 |
|---|---|---|
| macOS | Xcode 命令行工具：`xcode-select --install` | 双击 `启动工程助手.command`（首次若被拦截：右键 → 打开） |
| Windows | Visual Studio Build Tools 的“使用 C++ 的桌面开发”与 Windows SDK；安装 Python 时勾选 “Add to PATH” | 双击 `启动工程助手.bat` |
| Linux | `build-essential`、`python3.12-venv`（Debian/Ubuntu 包名） | 终端运行下方命令 |

任何平台也都可以在项目目录运行：

```sh
node scripts/start-local.mjs --install --open
```

启动后浏览器打开 <http://127.0.0.1:4310>，点击输入框下方的模型按钮填写 API Key 并保存，再点任一测试案例即可运行。

首次启动会安装依赖并构建 AGH，需要几分钟。依赖默认从国内镜像下载（Python：清华源；npm/pnpm：npmmirror）；海外网络可设置 `ENGINEERAGENT_MIRROR=off` 改用官方源。终端窗口保持打开，按 Ctrl+C 停止。

## 模型

默认 **官方 Agnes / agnes-3.0-flash**；也可接入 OpenAI 兼容或 Anthropic 兼容服务（模型按钮中选择接口、地址、模型名并填写 Key）。各接口的 Key 只保存在本机 `data/` 目录，不进入仓库或提交包。对 MiniMax-M3 会自动关闭思考（请求附带 `thinking: {type: "disabled"}`），避免思考耗尽单次输出额度。

## 测试案例与执行记录

每个任务页输入框下方都有测试案例，点击即经 AGH 运行：1 张装配图（4 种零件、15 个实例）、1 张缺尺寸零件图、2 份采购单、3 个检索，分为常规测试、边界测试和异常测试。Agnes 3.0 Flash 的运行结果与核对方法见 [docs/demo-cases.md](docs/demo-cases.md)；原生执行记录在 `assets/evaluation/agh-runs/`，也可在“历史记录”页导出。

## 工作原理

```
浏览器（React）──HTTP──▶ 本地服务（Node/Express）──▶ AGH（锁定 commit，工业插件 + 本机模型代理）
                                   │                         │ 工具调用
                                   ▼                         ▼
                         资产库 / 订单台账 / 历史记录    CAD 工具（Python + CadQuery）
```

- AGH 锁定官方仓库 [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness) 的 commit `cde816b8`（`integrations/agh/runtime-lock.json`），工业插件位于 `integrations/agh/industrial-tools/`。
- 模型 Key 由本机代理转发，不进入 AGH 进程。
- 几何结论来自工具对实体的实测（尺寸、孔位、装配位置、拆卸路径），不采信模型自述。CAD 工具说明见 [tools/cad/README.md](tools/cad/README.md)。

## 常见问题

- **端口被占用**：自动从 4310 起寻找空闲端口，终端会显示实际地址。
- **下载失败**：保留报错重试；镜像不可用时设 `ENGINEERAGENT_MIRROR=off`。
- **Windows 构建 AGH 失败**：需安装 Visual Studio Build Tools 的“使用 C++ 的桌面开发”与 Windows SDK。
- **已有 Python 不是 3.12**：可用 `ENGINEERAGENT_PYTHON=/path/to/python3.12` 指定；已有不兼容的 `.venv` 请先移走。
- **macOS 首次检查 CadQuery 很慢**：系统首次验证原生库签名可能需数分钟，终端会持续显示进度。
- **AGH 目录被改动**：安装脚本会停止以免覆盖；移走 `integrations/agh/vendor-runtime` 后重试。

## 开发与验证

```sh
node scripts/verify-local.mjs   # 构建、界面、打包、CAD、服务与 AGH 测试，无需模型 Key
```

## 许可

本项目代码以 MIT 许可发布。AGH 为 Apache-2.0（许可与 NOTICE 见 `third-party/agnes-harness/`）。公开工程资产保留各自上游许可，来源与条件见 [docs/asset-sources.md](docs/asset-sources.md)。
