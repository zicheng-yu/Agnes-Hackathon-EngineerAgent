# CAD 工具执行层

真实 CadQuery/OpenCascade 几何运算；输入为 JSON，不执行输入提供的 Python。项目坐标使用 **mm / Z-up**；GLB 也保留这一坐标，客户端必须按 manifest 处理，不应假设它是米/Y-up。

```sh
.venv/bin/python -m pip install -r tools/cad/requirements.txt
.venv/bin/python tools/cad/runner.py build --input plan.json --output data/runs/example
.venv/bin/python -m unittest discover -s tests/cad -v
.venv/bin/python tools/cad/generate_assets.py
```

CLI 的操作为 `build`、`validate`、`project`、`patch`、`assembly`、`import`、`compare_views`。stdout 返回一份 JSON，同时写入输出目录的 `manifest.json`。失败时退出码为 2，包含稳定错误码、错误说明、失败特征 ID。

`status: completed` 表示运算完成并已输出文件，不代表尺寸/路径检查全部通过。界面必须读取 `verification.passed`。装配该字段汇总部件检查与路径检查；导入 STEP 只检查 B-rep 有效性；STL 没有 B-rep，验证结果为 `null`，不能显示“CAD 验证通过”。无错误日志也不能替代验证结果。

## 零件 DSL

```json
{
  "id": "new-bracket", "units": "mm",
  "parameters": {"thickness": 12},
  "features": [
    {"id": "stock", "op": "box", "size": [80, 60, {"param":"thickness"}]},
    {"id": "mount-holes", "op": "hole", "diameter": 9, "points": [[-25,-15],[25,-15],[-25,15],[25,15]]},
    {"id": "corner-round", "op": "fillet", "selector": "|Z", "radius": 3}
  ],
  "checks": [{"kind":"bbox", "axis":"z", "expected":12, "tolerance":0.05}]
}
```

可用操作：`box`、`cylinder`、`sketch`、`extrude`、`revolve`、`union`、`cut`、`intersect`、`hole`（含 counterbore）、`pattern`（linear/circular）、`fillet`、`chamfer`、`transform`、`mirror`。草图支持 circle、rectangle、polygon、regular_polygon、slot。实体操作默认使用前一个 feature 作为 `base`，可显式指定引用；布尔操作使用 `tool` 引用。原语可附 `translation` 和 XYZ 顺序的欧拉角 `rotation`。`result` 可指定最终特征 ID。

`box` 默认 `centered:[true,true,false]`：长度 L、宽度 W、高度 H 对应 X∈[-L/2,L/2]、Y∈[-W/2,W/2]、Z∈[0,H]。`hole.points` 是所选 face 的**局部工作平面坐标**，不是图纸左下角坐标。该工作平面采用全局原点在所选平面上的投影；经过平移/旋转后不能假定原点等于面中心。

每个 `hole` 点沿同一个工作平面的负法向，用实际 `depth` 或 CadQuery through 深度建立圆柱刀具；沉孔同时加入其独立直径/深度的刀具。工具逐点试切并实测去料体积，拒绝无可测去料的请求，返回 `HOLE_NO_MATERIAL_REMOVAL`。错误含失败点的零起始 index、局部/世界坐标、实际工作平面原点/坐标轴、钻深与去料量；整项 feature 失败，不返回部分成功的孔阵列。空点列表返回 `INVALID_HOLE_POINTS`。

该检查使用真实母体布尔运算，不只看外包围盒或最高面的边界。因此跨过空气、在实际钻深内切到较低台阶的孔仍合法；深度未触及母体、越界、重复点或已有等径通孔的空切会报错。扩大已有孔或增加沉孔只要确有去料仍允许。成功的 `feature_log[].hole_cuts` 逐点记录实际去料量；这证明各请求产生切削效果，不等于独立完整圆孔计数、孔位/公差或可制造性验证。相交孔和边界切口仍应由明确的几何检查或 `cut` 特征表达，不从去料量推断其制造语义。

每个 feature 保持稳定 ID。`patch` 输入为 `{ "plan": <原计划>, "patches": [{"feature_id":"stock", "set":{"size":[80,60,13]}}], "parameters":{} }`。补丁保留其他特征的定义，当前实现重新执行整个有序特征树，尚未缓存内核中间结果。

检查必须放在 `plan.checks`。`patch` 顶层出现 `checks`（包括空数组或 null）会返回 `INVALID_PATCH`，避免被静默忽略；原计划的检查不会被顶层字段覆盖，也不会因修复而自动放宽。

验证来自实际 B-rep：有效性、独立实体数、体积、面积、包围盒、质心、面数、边数。明确检查支持 bbox、volume、solids、valid、circular_edge_diameter。最后一项仅确认存在接近要求直径的圆边，不声称识别了完整孔语义或孔数。投影使用内核生成 front/top/side SVG，包含隐藏线。`views/metadata.json` 保存从 B-rep 实测的各视图宽高、世界坐标轴方向、导出比例 `px_per_mm` 与投影原点；manifest 通过 `files.view_metadata` 引用。

包围盒使用 `BRepBndLib.AddOptimal(..., useTriangulation=False, useShapeTolerance=False)` 测量解析几何，避免网格化之后默认 bbox 被三角化容差放大。公差不为迎合模型而放宽。

输出包括真实 `model.step`、`model.glb`、`mesh.json`、三视图、原始 `feature-plan.json` 和验证/执行记录。mesh 的 positions 为 `[[x,y,z],...]`、indices 为 `[[a,b,c],...]`。

## 装配

```json
{
  "id":"fixture", "units":"mm", "parts":["<完整零件DSL对象>"],
  "instances":[{"id":"jaw-1","part_id":"jaw","translation":[0,0,20],"rotation":[0,0,0],"explode":[0,0,80],"sequence":1}],
  "path_samples":6
}
```

重复件可用一个实例条目展开：`"polar":{"count":4,"pcd":76,"start_angle":0}` 在以 translation 为圆心的分度圆上均布（第一件在 +X），`"points":[[x,y],...]` 按相对 translation 的坐标放置；展开后实例编号为 `<id>-1…<id>-n`，其余字段（rotation、explode、sequence）沿用。`assembly-plan.json` 保留未展开的原始输入，manifest 记录展开后的实例。

部件定义和重复实例分别保存。实例有原始平移/旋转、爆炸位移、拆卸序号和 mesh 引用。BOM 按 part_id 计数。拆卸检查按序移动，每条轨迹先做 AABB 初筛，再做离散位置的 B-rep 交集体积检查；输出初始干涉和逐步碰撞。通过离散采样不代表连续运动已被证明可行，同时播放的页面爆炸仅为示意，不等同于已检查的顺序拆卸。显式给定放置与路径，不将其称为自动装配约束求解。

## 导入

`import` 输入 `{ "path":"项目内绝对STEP/STL路径", "id":"...", "project":false }`。STEP 保留独立 solids，STL 保留连通网格组件，均不会 fuse。当前不读取 STEP 产品层级或名称，不将网格连通块当作已验证的机械部件。导入几何的径向展开明确标记为未验证的示意，不纳入图纸重建成果。STL 原文件不包含单位，默认 mm 并在 manifest 记录假设。

## 已裁切视图比较

```json
{
  "source": {"path":"/project/source.png", "px_per_mm":8},
  "projection": {"path":"/project/model/views/top.svg", "px_per_mm":6, "svg_visible_only":true},
  "registration": {
    "rotation_degrees":0, "translation_px":[0,0],
    "source_origin_px":[340,260], "projection_origin_px":[280,220]
  },
  "pre_cropped_views":true,
  "tolerance_mm":0.15,
  "normalization_length_mm":80,
  "minimum_match_fraction":0.98,
  "exclude_regions":[]
}
```

PNG/SVG 输入必须是同一已隔离的视图；也可各自提供 `crop:[x,y,width,height]`，原点随之以裁切后坐标为准。必须显式提供比例、旋转和平移，不自动拟合整页。缩放严格等于两份 `px_per_mm` 的比值，仅允许统一缩放。`scale_x/scale_y/shear` 等参数会拒绝；投影的任一几何轮廓离开源图画布也会拒绝，以免裁切隐藏多余结构。

图像像素坐标为 x 向右、y 向下，正角度按这一坐标系顺时针旋转。变换为 `source_origin + translation + scale × rotation × (projection_point − projection_origin)`。

工具基于阈值轮廓与 SciPy 欧氏距离变换，输出双向缺失/额外边像素、区域框、precision/recall、对称平均距离、P95/最大距离（mm）及按明确参考长度归一化的距离。`overlay.png` 绿色为匹配、红色为源轮廓未得到匹配、蓝色为额外投影；灰色为明确排除的标注区域。排除框是源图配准后坐标，作用于两张图，不自动识别文字、尺寸线或隐藏线。

`svg_visible_only:true` 排除显式虚线 SVG 图层；双方必须使用一致的可见/隐藏轮廓定义。输入标尺来自调用者或 CAD SVG，工具记录其来源，不声称自动校准标尺。2D 一致不能证明 3D 唯一性或可制造性。

运行 `.venv/bin/python tools/cad/generate_evidence.py` 会生成 `assets/generated/evidence/plate-hole-repair` 的真实构建、比较和补丁报告：将明确参数中的 4×Ø10 孔恢复到 4×Ø9，保持比例与阈值，展示局部差异归零。该记录明确是确定性工具回归，不是模型读图或自主修复成绩。

## 自建演示资产

`generate_assets.py` 生成 19 实例双法兰密封连接组件、18 实例双导柱夹具、独立部件参数和输入图。全部明确标识为自建、CC0-1.0、无真实企业生产历史。参考计划/STEP 与 `drawing-inputs` 分开存放；工作流输入目录只能注入图纸，不能注入答案参数。当前多视图输入 sheet 只标注总体尺寸，内部制造尺寸可能欠约束，应作为“待补充尺寸”输入，不得视为已具备完整尺寸的生产图或重建成功证据。

另有尺寸完整的 `drawing-inputs/mounting-plate-complete.svg`，含 80×60×12 外形、4×Ø9 通孔、50×30 居中孔距及 R3 圆角。参数真值与参考 CAD 在 `reference-plans`、`reference-models` 中隔离保存。工具台三份显式参数示例位于 `tools/cad/examples`，选用示例建模不得包装为图纸自动重建。

## API 依据

- CadQuery 官方 API: https://cadquery.readthedocs.io/en/latest/apireference.html
- CadQuery 官方导入导出: https://cadquery.readthedocs.io/en/latest/importexport.html

安装验证使用 CadQuery 2.6.1。工具没有网络调用，不读取模型密钥；目前没有视觉模型读图能力。限定 JSON 操作减少可执行输入面，但此进程不是安全沙箱，调用方仍须设置超时与并发上限。
