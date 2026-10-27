# 工程任务契约 v0.1（Web / WorkBuddy 共用）

状态：草案，自 2026-10-27 起作为 D1–D4 的开发基线（Linear YOU-89）。修改字段名、状态或错误码时，须在文末“变更记录”登记，并同步通知三个角色。

本契约描述**建议实现**的工程任务服务。实现进度以代码和测试为准；文中“当前实现”一词只用于已经合入的能力。

## 1. 范围

- 一个任务（job）对应一张图纸中的一个零件；本轮支持两类零件族：`mounting_plate`（安装板）与 `flange`（法兰）。
- 长度单位统一为 `mm`。图纸单位不是 mm、或单位相互矛盾时，进入澄清状态，不自动换算。
- 浏览器与 WorkBuddy 调用同一组 HTTP 接口；MCP 只是适配层，不保存独立的任务状态。
- 不做：NPU 优化、原生移动应用、通用装配约束求解、真实 ERP/MES 写入、CAM、完整 GD&T 检验。D4 结束时若两类零件不能稳定闭环，收缩至安装板一类。

## 2. 核心对象

| 对象 | 标识 | 可变性 | 说明 |
| --- | --- | --- | --- |
| Document | `document_id` | 不可变 | 原始上传文件、`sha256`、页数、MIME。原图始终保留，不以预览图替代。 |
| Job | `job_id` | 状态可变 | 用户看到的工程任务，跨修订保持同一 ID。 |
| Run | `run_id` | 终态后不可变 | 一次执行：`extract`（提取证据）或 `build`（建模与检查）。 |
| Evidence | `evidence_id` | 不可变 | 某次提取运行得到的图纸字段候选，带来源位置。 |
| ConstraintVersion | `job_id` + `version` | 草稿可变，确认后冻结 | 控制建模的尺寸集合，每个值都指向证据或人工输入。 |
| Check | `check_id` | 随 build run 冻结 | 由已确认约束生成的验收项及实测结果。 |
| Artifact | `run_id` + `name` | 不可变 | STEP、GLB、视图、检查报告等产物。 |
| AccessToken | `token_id` | 可撤销 | 供 WorkBuddy/脚本使用的 Bearer 凭证，绑定到一个访问主体。 |

### 2.1 Job

```json
{
  "job_id": "1d5c…",
  "status": "waiting_confirmation",
  "stage": "review",
  "family": "mounting_plate",
  "document_id": "8f2e…",
  "title": "EA-D01 安装板",
  "current_constraint_version": 1,
  "confirmed_constraint_version": null,
  "latest_runs": { "extract": "run-…", "build": null },
  "blocking_issues": [
    { "code": "FIELD_MISSING", "field": "thickness", "message": "图纸未给出板厚" }
  ],
  "created_at": "2026-10-28T02:00:00.000Z",
  "updated_at": "2026-10-28T02:00:05.000Z"
}
```

`stage` 只用于界面提示：`extract`、`review`、`build`、`done`。判断能否继续操作时只看 `status`。

### 2.2 Run

```json
{
  "run_id": "4a9b…",
  "job_id": "1d5c…",
  "kind": "build",
  "status": "succeeded",
  "constraint_version": 2,
  "attempt": 1,
  "verdict": "passed",
  "error": null,
  "artifacts": [{ "name": "model.step", "mime": "application/step", "bytes": 48213, "sha256": "…" }],
  "queued_at": "…", "started_at": "…", "finished_at": "…"
}
```

`verdict` 仅 build run 使用：`passed`（全部检查通过）、`failed`（至少一项未通过）、`not_evaluated`（未能执行检查）。`status: succeeded` 只表示运行正常结束；**任务成功必须同时满足 `verdict: passed`**。

## 3. 状态与合法转移

### 3.1 Job 状态

| 状态 | 含义 | 可转移到 |
| --- | --- | --- |
| `queued` | 已有待执行的 run | `running`、`canceled` |
| `running` | 提取或建模正在执行 | `waiting_confirmation`、`succeeded`、`failed`、`canceled` |
| `waiting_confirmation` | 等待用户补充、选择或确认约束 | `queued`（确认并提交建模）、`canceled` |
| `succeeded` | 当前确认版本已建模，且全部检查通过 | `waiting_confirmation`（用户发起修订） |
| `failed` | 提取或建模失败，或检查未通过 | `waiting_confirmation`（修改约束）、`queued`（同一版本重试） |
| `canceled` | 用户取消 | 无 |

- 检查未通过时 Job 为 `failed`，`error.code = CHECKS_FAILED`；产物仍可下载，但界面必须标记“未通过检查”，不能显示为完成。
- `succeeded`/`failed` 不是永久终态：修订会产生新约束版本，旧 run 与旧产物保持原状，可按 `run_id` 追溯。
- 服务重启后，租约过期的 `running` run 按 `RUN_INTERRUPTED` 记为 `failed`；不会自动重放可能计费的提取。

### 3.2 Run 状态

`queued → running → succeeded | failed | canceled`，以及 `queued → canceled`。终态 run 的输入、结果、检查和产物不可修改。

## 4. 来源标记

每条证据和每个约束值都必须同时带 `provider` 与 `source_mode`：

| `source_mode` | 含义 | 展示要求 |
| --- | --- | --- |
| `live` | 本次运行中对原始文件实际执行的提取 | 正常展示 provider 名称 |
| `recorded` | 回放事先保存的 provider 响应，仅用于适配测试和演示备份 | 必须标注“回放数据”，不得称为实时解析 |
| `manual` | 用户输入或用户选择的值，没有图纸位置 | 标注“人工输入”，记录操作者和时间 |

`provider` 取值：`werk24`、`pdf_text`（矢量 PDF 文字层）、`vision_model`、`manual`。新增 provider 须先登记在本节。

## 5. 证据（Evidence）

```json
{
  "evidence_id": "ev-…",
  "extraction_run_id": "run-…",
  "provider": "pdf_text",
  "source_mode": "live",
  "kind": "dimension",
  "raw_text": "4 x Ø10 THRU",
  "parsed": { "count": 4, "diameter": "10", "through": true },
  "value": "10",
  "unit": "mm",
  "tolerance": { "upper": null, "lower": null },
  "location": { "page": 1, "bbox": [508.2, 403.1, 571.9, 411.6], "space": "pdf_pt_top_left" },
  "confidence": null,
  "candidate_fields": ["hole_diameter", "hole_count"]
}
```

- 数值一律以十进制字符串保存原始精度（`"9.0"` 与 `"9"` 不合并为浮点后再比较来源）。
- `confidence` 只转存 provider 原值，不解释为校准后的正确概率；没有就写 `null`。
- `location.space` 声明坐标系：`pdf_pt_top_left`（PDF 点，左上原点）、`werk24_sheet`（Werk24 纠正旋转后的 sheet 图像坐标，不能直接画在原图上）、`image_px`。
- 提取只产生**候选**。字段归属（例如哪一个“96”是 X 向孔距）由规则、模型或用户完成；模型只能从已有证据中选择，不能新造数值。

## 6. 约束版本（ConstraintVersion）

```json
{
  "job_id": "1d5c…",
  "version": 2,
  "parent_version": 1,
  "status": "confirmed",
  "change_kind": "user_revision",
  "change_note": "孔径改为 Ø9",
  "family": "mounting_plate",
  "values": {
    "length": { "value": "120", "unit": "mm", "origin": "evidence", "evidence_ids": ["ev-…"] },
    "hole_diameter": { "value": "9", "unit": "mm", "origin": "manual", "previous": "10" }
  },
  "blocking_issues": [],
  "content_hash": "sha256:…",
  "confirmed_by": "owner:…",
  "confirmed_at": "…"
}
```

规则：

1. 每个任务同一时刻最多一个 `draft` 版本；只有草稿可以修改，修改须携带 `base_hash`，不一致返回 `CONSTRAINT_VERSION_STALE`。
2. 确认时重新计算 `blocking_issues`；存在必填缺失、单位冲突、取值冲突或不支持特征时返回 `CONSTRAINTS_INCOMPLETE`，不允许“先建出来再说”。
3. 确认后的版本只读，`content_hash` 覆盖族、字段值、单位、来源和公差。build run 记录所用 `version` 与 `content_hash`。
4. 用户修订从某个已确认版本派生新草稿，`change_kind = user_revision`；补充缺项为 `clarification`；提取直接生成的首个草稿为 `extraction`。
5. 系统修复（重新生成计划、重试 worker）不能创建或修改约束版本。不存在“为通过检查而改目标值”的接口。
6. `origin` 取值：`evidence`（引用一条或多条证据）、`manual`（人工输入）、`derived`（由已确认字段按族规则推出，例如对称孔位，须写明规则名）。不存在 `default`：可选特征缺失表示该特征不存在，图上出现但读不出数值则为缺失。

### 6.1 零件族字段

`mounting_plate`（矩形板，Z 向贯通孔，本轮孔阵为关于中心对称的 4 孔）：

| 字段 | 含义 | 必填 |
| --- | --- | --- |
| `length` / `width` / `thickness` | 外形 X / Y / Z 尺寸 | 是 |
| `hole_count` | 安装孔数量，本轮仅支持 4 | 是 |
| `hole_diameter` | 安装孔直径 | 是 |
| `hole_pitch_x` / `hole_pitch_y` | X / Y 向孔中心距 | 是 |
| `center_hole_diameter` | 中心通孔直径 | 否 |
| `corner_radius` | 竖直外棱圆角 | 否 |
| `material` | 材料牌号，仅记录，不参与几何 | 否 |

`flange`（圆盘，中心孔，螺栓孔均布于分度圆）：

| 字段 | 含义 | 必填 |
| --- | --- | --- |
| `outer_diameter` / `thickness` | 外径 / 盘厚 | 是 |
| `bore_diameter` | 中心孔径 | 是 |
| `bolt_circle_diameter` | 螺栓孔分度圆 PCD | 是 |
| `bolt_hole_count` / `bolt_hole_diameter` | 螺栓孔数量（3–12）/ 直径 | 是 |
| `bolt_start_angle` | 首孔相对 +X 轴角度；未标注时不检查绝对角度 | 否 |
| `hub_diameter` / `hub_height` | 凸台外径 / 高度，须成对出现 | 否 |
| `material` | 材料牌号，仅记录 | 否 |

超出上表的特征（螺纹、沉孔、槽、倒角、非均布孔、非 mm 单位等）记为 `UNSUPPORTED_FEATURE` 阻塞项，并保留原文证据。

## 7. 检查与验收边界

- 检查项只由**已确认约束版本**生成，不读取建模计划中的 `checks`，也不由模型提供期望值。
- 检查对象是本次 run 导出的 `model.step` 重新导入后的 B-rep，而不是建模过程的内存对象。
- 每项检查记录：`target`（字段）、`expected`（名义值与制造公差，若图纸给出）、`method`、`numeric_tolerance`（几何计算容差，默认 0.05 mm）、`measured`、`result`（`pass`/`fail`/`not_evaluated`）。
- `numeric_tolerance` 只表示几何计算误差，不等于图纸公差、配合等级或 GD&T 结论；报告中两者分列。
- 首版检查：B-rep 有效、单一实体、外形包围盒、孔数量与直径、孔中心位置（安装板）、PCD 与均布（法兰）、中心孔直径。

## 8. 产物

build run 成功导出后保存以下产物（缺失的文件不得在清单中出现）：

| 名称 | MIME | 说明 |
| --- | --- | --- |
| `model.step` | `application/step` | CAD 交换文件，mm / Z-up |
| `model.glb` | `model/gltf-binary` | 可视化网格，保留 mm / Z-up，客户端须按 manifest 处理 |
| `views/front.svg`、`views/top.svg`、`views/side.svg` | `image/svg+xml` | 内核投影视图，含隐藏线 |
| `feature-plan.json` | `application/json` | 由约束版本确定性生成的特征计划 |
| `check-report.json` | `application/json` | 独立检查结果，绑定 `constraint_version` 与 `content_hash` |
| `manifest.json` | `application/json` | CAD 执行记录（已去除本机绝对路径） |

## 9. 访问权限

- 访问主体（owner）：浏览器使用现有签名访客 Cookie（`ea_visitor`）；WorkBuddy 与脚本使用 `Authorization: Bearer <token>`，token 由浏览器端为**同一主体**创建，因此两个入口看到同一批任务。
- Document、Job、Run、Evidence、Artifact 均按 owner 隔离；访问不属于自己的资源一律返回 `404`，避免枚举。
- token 只在创建时返回一次，服务端只存 SHA-256；可列出、撤销。跨设备打开同一任务（手机）通过一次性、10 分钟有效的配对链接完成，详细设计归 YOU-99。
- Werk24 key、模型 key 只在服务端环境变量中；不写入任务记录、日志、错误信息、产物、文档或 Issue。产物 JSON 写出前去除本机绝对路径。
- 工程任务产物不经过公开的 `/runs/` 静态目录，只能通过带权限校验的下载接口读取。

## 10. HTTP 接口

前缀 `/api/engineering`。请求与响应均为 JSON（上传与下载除外）。写操作支持 `Idempotency-Key` 请求头。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /documents` | `multipart/form-data` 字段 `file`；返回 Document |
| `POST /jobs` | `{document_id, family?, provider?, title?}` → `201` Job，并排队提取 run |
| `GET /jobs` | 当前主体的任务列表 |
| `GET /jobs/:job_id` | 任务详情、阻塞项、最新 run 与产物清单 |
| `GET /jobs/:job_id/evidence` | 证据列表 |
| `GET /jobs/:job_id/constraints?version=` | 指定或当前约束版本 |
| `PUT /jobs/:job_id/constraints/draft` | `{base_hash, family?, values}` 修改草稿 |
| `POST /jobs/:job_id/constraints/confirm` | `{version, content_hash, build?: true}` 冻结版本，可同时提交建模 |
| `POST /jobs/:job_id/revisions` | `{from_version, changes, note}` 由已确认版本派生修订草稿 |
| `POST /jobs/:job_id/builds` | `{constraint_version}` 提交建模；同一版本已有未失败的 run 时返回该 run |
| `GET /jobs/:job_id/runs/:run_id` | run 详情、检查结果、产物清单 |
| `GET /jobs/:job_id/runs/:run_id/artifacts/:name` | 下载产物（权限校验） |
| `POST /jobs/:job_id/cancel` | 取消排队或执行中的 run |
| `POST /tokens` / `GET /tokens` / `DELETE /tokens/:token_id` | 创建（仅返回一次）、列出、撤销访问 token |

所有 `GET` 接口无副作用：不会触发提取、建模或计费调用。

## 11. 错误

错误响应沿用现有 live runtime 的格式：

```json
{ "error": "CONSTRAINTS_INCOMPLETE", "message": "板厚缺失，确认前请补充。", "details": { "blocking_issues": [ … ] } }
```

| HTTP | `error` | 说明 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数缺失或格式错误 |
| 400 | `UNSUPPORTED_DOCUMENT` | 文件类型、签名或大小不符合要求 |
| 401 | `AUTH_REQUIRED` / `TOKEN_INVALID` | 无访客会话或 token 无效/已撤销 |
| 404 | `JOB_NOT_FOUND` / `DOCUMENT_NOT_FOUND` / `RUN_NOT_FOUND` / `ARTIFACT_NOT_FOUND` | 不存在或不属于当前主体 |
| 409 | `INVALID_TRANSITION` | 当前状态不允许该操作 |
| 409 | `CONSTRAINTS_INCOMPLETE` | 仍有阻塞项，不能确认或建模 |
| 409 | `CONSTRAINT_VERSION_STALE` | 草稿已被其他入口修改 |
| 409 | `CONSTRAINT_VERSION_IMMUTABLE` | 试图修改已确认版本 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一个幂等键对应了不同请求内容 |
| 422 | `UNSUPPORTED_FAMILY` / `UNSUPPORTED_FEATURE` | 超出本轮支持范围 |
| 429 | `QUEUE_FULL` / `RATE_LIMITED` | 排队已满或请求过于频繁，附 `Retry-After` |
| 503 | `PROVIDER_NOT_CONFIGURED` | 例如服务端未配置 Werk24 凭证 |

run 内部失败写入 `run.error.code`：`PROVIDER_ERROR`、`PROVIDER_TIMEOUT`、`RUN_TIMEOUT`、`RUN_INTERRUPTED`、`BUILD_FAILED`、`CHECKS_FAILED`、`INTERNAL_ERROR`。错误信息不得包含凭证或本机绝对路径。

## 12. 幂等与副作用

- 带 `Idempotency-Key` 的写请求：同一主体、同一键、同一请求内容返回首次结果；内容不同返回 `IDEMPOTENCY_KEY_REUSED`。
- 提取缓存键为 `(document.sha256, provider, provider_config_version)`；同一文件重复创建任务时复用已成功的提取结果并标明来源 run，不重复计费。确需重新提取必须显式提交并记录原因。
- 同一约束版本已有 `queued`、`running` 或 `succeeded` 的 build run 时，再次提交返回该 run；只有上次失败才新建 `attempt + 1`。

## 13. 超时、并发与隔离（默认值）

| 项 | 默认 |
| --- | --- |
| 提取 run 超时 | 120 s（Werk24 为异步任务，单独计时） |
| 建模 + 检查 run 超时 | 180 s |
| 全局并发 | 2 个 run |
| 排队上限 | 每主体 10 个、全局 50 个未完成 run |
| 上传大小 | 单文件 ≤ 10 MiB（同 Werk24 单文件上限），PDF/PNG/JPEG |

每个 run 使用独立工作目录，结束后只把产物清单中的文件移入私有存储，并删除工作目录。CAD 子进程只接受受限 JSON 计划，不执行任何输入提供的代码。

## 14. MCP 工具映射（YOU-98）

WorkBuddy 连接器单次请求建议 30 秒内返回，因此耗时操作一律“提交 → 返回 ID → 查询”。

| MCP 工具 | 对应接口 |
| --- | --- |
| `engineering_submit_drawing` | `POST /documents` + `POST /jobs` |
| `engineering_get_job` | `GET /jobs/:job_id`（含阻塞项与产物） |
| `engineering_get_constraints` | `GET /jobs/:job_id/constraints` + `GET /evidence` |
| `engineering_update_constraints` | `PUT /constraints/draft` |
| `engineering_confirm_and_build` | `POST /constraints/confirm`（`build: true`） |
| `engineering_revise` | `POST /revisions` |
| `engineering_get_artifacts` | `GET /runs/:run_id`，返回带权限的下载地址 |

远程 MCP 无法读取用户本机文件路径；图纸交接方式（上传链接、Base64 小文件或 WorkBuddy 文件能力）须在 D1–D2 实测后补入本节。

## 15. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-10-27 | v0.1 | 初稿：对象、状态、来源标记、证据、约束版本、检查边界、产物、权限、接口、错误、幂等与超时 |
