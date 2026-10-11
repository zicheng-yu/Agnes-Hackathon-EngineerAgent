# 企业历史库演示资产：来源与授权记录

采集日期：2026-10-09（Asia/Shanghai）。本批为 **28 个独立机械组件/主体模型，来自 7 个上游项目**，不是 28 个不同的上游项目。主模型 20 个 STEP、8 个 STL，约 40.3 MB；无重复主文件 SHA256。没有把参数改色、镜像件或重复格式单独计数。

该批用于“公开机械资产示例库”，不代表本企业实际生产历史。材料仅在上游目录明确写明时填入；库存、加工报价、加工记录保持空值。资产不能作为“图纸自动重建”盲测时可访问的答案。

## 读取方式

- `assets/catalog/catalog.json`：前端/服务端统一目录，JSON 数组。
- `assets/catalog/<id>/metadata.json`：单件资料及文件检查记录。
- `assets/catalog/<id>/source.step` 或 `source.stl`：原始主模型。
- `previewPath`（存在时）：同一上游提供的配套 STL，未假定其与 STEP 已逐面核对。
- `assets/sources/<source-id>/LICENSE`：上游原许可证原文。
- `assets/sources/<source-id>/source.json`：许可证据、作者、固定提交和检索日期。
- `assets/sources/registry.json`：来源汇总；`revisions.json`：固定上游提交。
- `assets/sources/acquire_catalog.py`：本项目编写的采集器，只下载数据与解压指定 STEP；不执行上游脚本。

每条目录记录包含 id、name、category、material、summary、useCase、sourceType、sourceUrl、license、format、localPath，并附下载 URL、固定 commit、作者、许可证路径、下载时间、SHA256、文件检查状态。摘要与用途是依据上游项目用途所做的中文整理，不是来源对制造能力的保证。

## 来源与再分发条件

软件或网站“免费可用”不等于 CAD 可公开分发。本批依据上游**目标机械资料所在仓库**的明确许可证进行选取，并保留原文和固定提交。外部素材维持原许可证，不能整体改标成本项目代码许可证。

| 来源 | 作者/机构 | 许可证 | 本项目保留的条件 |
|---|---|---|---|
| [PCrnjak/Compliant-robotic-gripper](https://github.com/PCrnjak/Compliant-robotic-gripper) | Petar Crnjak | [MIT](https://github.com/PCrnjak/Compliant-robotic-gripper/blob/df56e1deee1bd89c8db86a24df8e3240e2448c24/LICENSE) | 随副本保留版权声明及完整许可。 |
| [Source-Robotics/SSG-48-adaptive-electric-gripper](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper) | Source Robotics / Petar Crnjak | [Apache-2.0](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/LICENSE) | 保留许可及原有版权/归属信息；如修改注明；如上游有适用 NOTICE 一并保留。 |
| [alireza-02/open-cycloidal-actuator](https://github.com/alireza-02/open-cycloidal-actuator) | alireza-02 | [MIT](https://github.com/alireza-02/open-cycloidal-actuator/blob/ef5e5e4dedef7c80a84d478d734db8392664ccbf/LICENSE) | 随副本保留版权声明及完整许可。 |
| [pollen-robotics/PincOpen](https://github.com/pollen-robotics/PincOpen) | Pollen Robotics | [CC-BY-SA-4.0](https://github.com/pollen-robotics/PincOpen/blob/1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7/LICENSE) | 署名、链接来源和许可；注明格式转换/修改；改编后的资产继续以相同许可提供。 |
| [BCN3D/BCN3D-Moveo](https://github.com/BCN3D/BCN3D-Moveo) | BCN3D Technologies | [MIT](https://github.com/BCN3D/BCN3D-Moveo/blob/0866a92501277636f76000a195d8a16d44b5b476/LICENSE) | 随副本保留版权声明及完整许可。 |
| [pachterlab/poseidon](https://github.com/pachterlab/poseidon) | Pachter Lab / Poseidon contributors | [BSD-2-Clause](https://github.com/pachterlab/poseidon/blob/5a139fed350bbf5d775ffa9650f465e557b6ccb0/LICENSE) | 源文件保留版权、条件和免责声明；二进制形式在资料中保留对应声明。 |
| [Synthetic-Automated-Systems/open_micro_pump](https://github.com/Synthetic-Automated-Systems/open_micro_pump) | Synthetic-Automated-Systems | [MIT](https://github.com/Synthetic-Automated-Systems/open_micro_pump/blob/6b410f499fa4bcb784e252840af7f00f384c7a48/LICENSE) | 随副本保留版权声明及完整许可。 |

上游 CAD 以各仓库发布者身份归属记录；本项目没有把开源标准件等同于品牌厂商背书。许可证原文优先于此处摘要。

## 主模型清单

带 ★ 的 4 件适合首屏展示；复杂程度仍须以实际模型预览决定。目录中的 `hero` 字段已标识。

| ID | 名称 | 用途 | 主格式 | 来源 | 许可 |
|---|---|---|---|---|---|
| compliant-gripper | 柔顺机器人夹爪主壳体 | 柔顺夹爪驱动与传动安装 | STEP | [compliant](https://github.com/PCrnjak/Compliant-robotic-gripper/blob/df56e1deee1bd89c8db86a24df8e3240e2448c24/Gripper_STEP.zip) | MIT |
| ssg48-drive-assembly | ★ SSG48 电动夹爪主体模型 | 自动上下料、末端执行器集成 | STL | [ssg48](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/SSG48_gripper_description/assets/gripper_SSG48.STL) | Apache-2.0 |
| ssg48-main-housing | SSG48 多腔驱动壳体 | 夹爪驱动系统定位与安装 | STEP | [ssg48](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/STEPS/Gripper%20STEP%20files/main_body.STEP) | Apache-2.0 |
| ssg48-drive-gear | SSG48 夹爪传动齿轮 | 小型电动夹爪动力传递 | STEP | [ssg48](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/STEPS/Gripper%20STEP%20files/gripper_gear.STEP) | Apache-2.0 |
| ssg48-moving-jaw | SSG48 导向滑动夹爪 | 平行抓取与末端改造 | STEP | [ssg48](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/STEPS/Gripper%20STEP%20files/jaw.STEP) | Apache-2.0 |
| ssg48-finray-finger | Fin Ray 柔顺夹指 | 曲面或易损物体自适应抓取 | STEP | [ssg48](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/gripper%20jaws/fin_ray_1.STEP) | Apache-2.0 |
| ssg48-ur-adapter | UR 机器人末端适配法兰 | 末端执行器安装适配 | STEP | [ssg48](https://github.com/Source-Robotics/SSG-48-adaptive-electric-gripper/blob/cb99f63e793e1887edfcfa8c07353b5c5bdedc51/STEPS/UR5%20adapter%20plate/UR_coupler_gripper.STEP) | Apache-2.0 |
| cycloid-main-ring | ★ 摆线减速器主环壳 | 紧凑机器人关节减速 | STEP | [cycloid](https://github.com/alireza-02/open-cycloidal-actuator/blob/ef5e5e4dedef7c80a84d478d734db8392664ccbf/1.%20Mechanical/STEP%20Files/Cycloidal%20Drive%20parts%20%28PETG%29/Main%20Ring.step) | MIT |
| cycloid-disc | 多孔摆线齿盘 | 偏心摆线运动及输出传递 | STEP | [cycloid](https://github.com/alireza-02/open-cycloidal-actuator/blob/ef5e5e4dedef7c80a84d478d734db8392664ccbf/1.%20Mechanical/STEP%20Files/Cycloidal%20Drive%20parts%20%28PETG%29/Bottom%20Cycloid%20Disc.step) | MIT |
| cycloid-shaft-adapter | 执行器输出轴适配件 | 执行器输出轴连接 | STEP | [cycloid](https://github.com/alireza-02/open-cycloidal-actuator/blob/ef5e5e4dedef7c80a84d478d734db8392664ccbf/1.%20Mechanical/STEP%20Files/Housing%20parts%20%28PLA%2B%29/Shaft%20Adapter.step) | MIT |
| cycloid-upper-mount | 关节执行器上支承壳 | 电机、轴承与减速机构定位 | STEP | [cycloid](https://github.com/alireza-02/open-cycloidal-actuator/blob/ef5e5e4dedef7c80a84d478d734db8392664ccbf/1.%20Mechanical/STEP%20Files/Housing%20parts%20%28PLA%2B%29/Upper%20Mount.step) | MIT |
| cycloid-testbench | 执行器测试台夹具 | 驱动器台架测试与固定 | STEP | [cycloid](https://github.com/alireza-02/open-cycloidal-actuator/blob/ef5e5e4dedef7c80a84d478d734db8392664ccbf/1.%20Mechanical/STEP%20Files/Test%20Bench%20%28optional%29/Test%20Bench%20Mount.step) | MIT |
| pincopen-top-plate | PincOpen 夹爪多孔顶板 | 低成本自动抓取装置 | STEP | [pincopen](https://github.com/pollen-robotics/PincOpen/blob/1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7/cad/step/Top_Plate.step) | CC-BY-SA-4.0 |
| pincopen-inner-link | PincOpen 精密内连杆 | 夹爪运动链与机构设计 | STEP | [pincopen](https://github.com/pollen-robotics/PincOpen/blob/1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7/cad/step/Internal_Rod.step) | CC-BY-SA-4.0 |
| pincopen-cam | PincOpen 驱动凸轮 | 紧凑夹爪运动转换 | STEP | [pincopen](https://github.com/pollen-robotics/PincOpen/blob/1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7/cad/step/Cam.step) | CC-BY-SA-4.0 |
| pincopen-tip-support | PincOpen 可换指尖支架 | 接触面适配与夹具快速更换 | STEP | [pincopen](https://github.com/pollen-robotics/PincOpen/blob/1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7/cad/step/Tip_Support.step) | CC-BY-SA-4.0 |
| pincopen-camera-base | 夹爪视觉相机安装座 | 手眼视觉与末端相机安装 | STEP | [pincopen](https://github.com/pollen-robotics/PincOpen/blob/1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7/cad/step/Camera_basement.step) | CC-BY-SA-4.0 |
| moveo-shoulder | ★ BCN3D Moveo 肩关节结构体 | 多轴机器人肩关节支撑 | STL | [moveo](https://github.com/BCN3D/BCN3D-Moveo/blob/0866a92501277636f76000a195d8a16d44b5b476/STL%20files/Articulation%202/2M1.STL) | MIT |
| moveo-elbow | BCN3D Moveo 肘关节结构体 | 多轴机器人肘关节集成 | STL | [moveo](https://github.com/BCN3D/BCN3D-Moveo/blob/0866a92501277636f76000a195d8a16d44b5b476/STL%20files/Articulation%203/3M1.STL) | MIT |
| moveo-wrist | BCN3D Moveo 腕关节结构体 | 机器人腕部传动支撑 | STL | [moveo](https://github.com/BCN3D/BCN3D-Moveo/blob/0866a92501277636f76000a195d8a16d44b5b476/STL%20files/Articulation%204/4M1.STL) | MIT |
| poseidon-pump-base | ★ Poseidon 注射泵导轨基座 | 精密液体输送与实验室自动化 | STEP | [poseidon](https://github.com/pachterlab/poseidon/blob/5a139fed350bbf5d775ffa9650f465e557b6ccb0/HARDWARE/pump/step/Pump%20Base.step) | BSD-2-Clause |
| poseidon-pump-carriage | Poseidon 注射泵滑动推座 | 定量推注运动机构 | STEP | [poseidon](https://github.com/pachterlab/poseidon/blob/5a139fed350bbf5d775ffa9650f465e557b6ccb0/HARDWARE/pump/step/Pump%20Carriage.step) | BSD-2-Clause |
| poseidon-optical-stage | Poseidon 显微成像上平台 | 光学模块与样品观测定位 | STEP | [poseidon](https://github.com/pachterlab/poseidon/blob/5a139fed350bbf5d775ffa9650f465e557b6ccb0/HARDWARE/microscope/step/Scope%20Top%20Stage.step) | BSD-2-Clause |
| poseidon-scope-base | Poseidon 显微平台基座 | 实验室精密仪器安装 | STEP | [poseidon](https://github.com/pachterlab/poseidon/blob/5a139fed350bbf5d775ffa9650f465e557b6ccb0/HARDWARE/microscope/step/Scope%20Base.step) | BSD-2-Clause |
| micropump-stator | 微流控蠕动泵定子 | 微流控小体积液体处理 | STL | [micropump](https://github.com/Synthetic-Automated-Systems/open_micro_pump/blob/6b410f499fa4bcb784e252840af7f00f384c7a48/pump1_1/parts_files/STL/6%20peristaltic%20pump%20stator.stl) | MIT |
| micropump-gearbox | 微流控泵减速箱基座 | 低成本微流控驱动机构 | STL | [micropump](https://github.com/Synthetic-Automated-Systems/open_micro_pump/blob/6b410f499fa4bcb784e252840af7f00f384c7a48/pump1_1/parts_files/STL/1%20gear%20box%20base.stl) | MIT |
| micropump-compound-gear | 微流控泵双联齿轮 | 泵驱动减速传动 | STL | [micropump](https://github.com/Synthetic-Automated-Systems/open_micro_pump/blob/6b410f499fa4bcb784e252840af7f00f384c7a48/pump1_1/parts_files/STL/3%20stacked%20gear.stl) | MIT |
| micropump-rotor | 微流控蠕动泵转子 | 定量蠕动泵送 | STL | [micropump](https://github.com/Synthetic-Automated-Systems/open_micro_pump/blob/6b410f499fa4bcb784e252840af7f00f384c7a48/pump1_1/parts_files/STL/9%20rotor%202.0.stl) | MIT |

## 已完成检查与实际边界

- 28 个主文件均已落盘，SHA256 及大小写入目录；STEP 的 ISO-10303-21 开始/结束标记均通过。
- 8 个主 STL 的二进制长度、三角形记录和有限坐标已检查；包围盒写入 `fileValidation`。STL 不自带可靠单位，记录为 `unspecified-in-STL`，没有猜成毫米。
- 19 个主 STEP 含 `MANIFOLD_SOLID_BREP`；SSG48 多腔主壳体使用 `BREP_WITH_VOIDS` 与 3 个闭壳。这是初始文本结构检查。后续已通过项目 CAD runner 导入：**20/20 STEP 的 OpenCascade B-rep 有效性检查通过**，不等于制造可行性或与任何图纸的一致性已验收。
- `ssg48-drive-assembly` 保留了历史兼容 ID，但实际名称为“SSG48 电动夹爪主体模型”，主文件采用上游官方 ROS 低面数 STL（8,496 个三角形）；不声称完整夹爪总成。其原 STEP 含 350 个开放壳/表面模型且无闭合实体，作为 `alternateCadPath` 保留，不能用于闭合实体证明。
- `compliant-gripper` 原下载包包含 14 个 STEP 组件；本条只选用 `Gripper_main_body.STEP`，名称为主壳体。原 ZIP 一并保留，没有把分散零件冒充装配模型。
- 未运行上游代码，未自动拼装多个独立部件，未生成虚构企业库存、加工价格或历史订单。

## 下游转换与展示

优先使用原 STEP 生成浏览器 GLB；保存转换工具及版本、输入 SHA256、输出 SHA256、单位处理与失败日志。网格转换不改动归属与许可条件，CC BY-SA 资产的改编版本继续保留原许可。界面同时显示来源项目、许可证和“公开机械资产”身份。

转换失败时回退到经过检查的原始 STL 或配套 `previewPath`。不得将开放表面 STEP 的成功显示当成闭合实体重建成功。源模型、图纸重建结果和企业合成运营记录应有可识别的数据来源。


## 2026-10-09 展示转换结果

28/28 资产均已提供浏览器 GLB 和 792×624 透明 PNG 缩略图。20 件 STEP 的内核有效性为 `passed`；8 件原 STL 只标为 `mesh-only`，不冒充 CAD 实体。GLB 共约 30.31 MB，单件最大约 5.76 MB。SSG48 主体保留 9 个网格连通块；这些连通块不是经语义确认的装配零件。

- `browserModelPath` / `browserModelUrl`：项目相对路径与以 `/assets/` 开头的静态 URL。
- `browserModelFormat`：当前均为 `GLB`。
- `browserMeshPath` / `browserManifestPath`：工具导出的真实网格与导入报告。
- `thumbnailPath` / `thumbnailUrl`：透明缩略图；通过 matplotlib 渲染真实网格，保留所有三角形，没有生成替代形状。
- `kernelValidation`：导入状态、实体/网格检查、实测信息、单位说明、工具报告路径、错误及时间。
- `previewIsReconstruction: false`：这些是既有公开 CAD 的转换展示，不是图纸重建成果。

`assets/catalog/display-verification.json` 保存文件检查汇总；`qa-contact-sheet.png` 是全部 28 件的目视检查拼图。GLB 头信息、长度、SHA256、缩略图非空及透明通道均已检查，且拼图已人工目视核对。

可复现命令：`.venv/bin/python assets/catalog/prepare_display.py --in-process`。其调用 `tools/cad/runner.py` 的同一 `runner.run('import', ...)` 实现，使用一个进程复用 CAD 原生库。`--force` 可重新导入；不加该参数时复用已有导入报告并重渲染缩略图。所有原始资料和许可证均保留。
