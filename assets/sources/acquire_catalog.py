"""Acquire pinned, licensed CAD data only; never execute upstream code."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/sources'
CATALOG = ROOT / 'assets/catalog'
REVISIONS = json.loads((SOURCE / 'revisions.json').read_text())
SOURCES = {
    'compliant': ('PCrnjak/Compliant-robotic-gripper', 'MIT', 'Petar Crnjak'),
    'ssg48': ('Source-Robotics/SSG-48-adaptive-electric-gripper', 'Apache-2.0', 'Source Robotics / Petar Crnjak'),
    'cycloid': ('alireza-02/open-cycloidal-actuator', 'MIT', 'alireza-02'),
    'pincopen': ('pollen-robotics/PincOpen', 'CC-BY-SA-4.0', 'Pollen Robotics'),
    'moveo': ('BCN3D/BCN3D-Moveo', 'MIT', 'BCN3D Technologies'),
    'poseidon': ('pachterlab/poseidon', 'BSD-2-Clause', 'Pachter Lab / Poseidon contributors'),
    'micropump': ('Synthetic-Automated-Systems/open_micro_pump', 'MIT', 'Synthetic-Automated-Systems'),
}
# id | source | upstream path | name | category | use | hero | material
ROWS = '''compliant-gripper|compliant|Gripper_STEP.zip|柔顺机器人夹爪主壳体|夹持与末端执行|柔顺夹爪驱动与传动安装|0|
ssg48-drive-assembly|ssg48|SSG48_gripper_description/assets/gripper_SSG48.STL|SSG48 电动夹爪主体模型|夹持与末端执行|自动上下料、末端执行器集成|1|
ssg48-main-housing|ssg48|STEPS/Gripper STEP files/main_body.STEP|SSG48 多腔驱动壳体|精密壳体|夹爪驱动系统定位与安装|0|
ssg48-drive-gear|ssg48|STEPS/Gripper STEP files/gripper_gear.STEP|SSG48 夹爪传动齿轮|减速与传动|小型电动夹爪动力传递|0|
ssg48-moving-jaw|ssg48|STEPS/Gripper STEP files/jaw.STEP|SSG48 导向滑动夹爪|夹持与末端执行|平行抓取与末端改造|0|
ssg48-finray-finger|ssg48|gripper jaws/fin_ray_1.STEP|Fin Ray 柔顺夹指|夹持与末端执行|曲面或易损物体自适应抓取|0|
ssg48-ur-adapter|ssg48|STEPS/UR5 adapter plate/UR_coupler_gripper.STEP|UR 机器人末端适配法兰|机器人结构件|末端执行器安装适配|0|
cycloid-main-ring|cycloid|1. Mechanical/STEP Files/Cycloidal Drive parts (PETG)/Main Ring.step|摆线减速器主环壳|减速与传动|紧凑机器人关节减速|1|PETG
cycloid-disc|cycloid|1. Mechanical/STEP Files/Cycloidal Drive parts (PETG)/Bottom Cycloid Disc.step|多孔摆线齿盘|减速与传动|偏心摆线运动及输出传递|0|PETG
cycloid-shaft-adapter|cycloid|1. Mechanical/STEP Files/Housing parts (PLA+)/Shaft Adapter.step|执行器输出轴适配件|减速与传动|执行器输出轴连接|0|PLA+
cycloid-upper-mount|cycloid|1. Mechanical/STEP Files/Housing parts (PLA+)/Upper Mount.step|关节执行器上支承壳|精密壳体|电机、轴承与减速机构定位|0|PLA+
cycloid-testbench|cycloid|1. Mechanical/STEP Files/Test Bench (optional)/Test Bench Mount.step|执行器测试台夹具|治具与安装|驱动器台架测试与固定|0|
pincopen-top-plate|pincopen|cad/step/Top_Plate.step|PincOpen 夹爪多孔顶板|夹持与末端执行|低成本自动抓取装置|0|
pincopen-inner-link|pincopen|cad/step/Internal_Rod.step|PincOpen 精密内连杆|夹持与末端执行|夹爪运动链与机构设计|0|
pincopen-cam|pincopen|cad/step/Cam.step|PincOpen 驱动凸轮|减速与传动|紧凑夹爪运动转换|0|
pincopen-tip-support|pincopen|cad/step/Tip_Support.step|PincOpen 可换指尖支架|夹持与末端执行|接触面适配与夹具快速更换|0|
pincopen-camera-base|pincopen|cad/step/Camera_basement.step|夹爪视觉相机安装座|治具与安装|手眼视觉与末端相机安装|0|
moveo-shoulder|moveo|STL files/Articulation 2/2M1.STL|BCN3D Moveo 肩关节结构体|机器人结构件|多轴机器人肩关节支撑|1|
moveo-elbow|moveo|STL files/Articulation 3/3M1.STL|BCN3D Moveo 肘关节结构体|机器人结构件|多轴机器人肘关节集成|0|
moveo-wrist|moveo|STL files/Articulation 4/4M1.STL|BCN3D Moveo 腕关节结构体|机器人结构件|机器人腕部传动支撑|0|
poseidon-pump-base|poseidon|HARDWARE/pump/step/Pump Base.step|Poseidon 注射泵导轨基座|流体与泵|精密液体输送与实验室自动化|1|
poseidon-pump-carriage|poseidon|HARDWARE/pump/step/Pump Carriage.step|Poseidon 注射泵滑动推座|流体与泵|定量推注运动机构|0|
poseidon-optical-stage|poseidon|HARDWARE/microscope/step/Scope Top Stage.step|Poseidon 显微成像上平台|光学与精密平台|光学模块与样品观测定位|0|
poseidon-scope-base|poseidon|HARDWARE/microscope/step/Scope Base.step|Poseidon 显微平台基座|光学与精密平台|实验室精密仪器安装|0|
micropump-stator|micropump|pump1_1/parts_files/STL/6 peristaltic pump stator.stl|微流控蠕动泵定子|流体与泵|微流控小体积液体处理|0|
micropump-gearbox|micropump|pump1_1/parts_files/STL/1 gear box base.stl|微流控泵减速箱基座|流体与泵|低成本微流控驱动机构|0|
micropump-compound-gear|micropump|pump1_1/parts_files/STL/3 stacked gear.stl|微流控泵双联齿轮|减速与传动|泵驱动减速传动|0|
micropump-rotor|micropump|pump1_1/parts_files/STL/9 rotor 2.0.stl|微流控蠕动泵转子|流体与泵|定量蠕动泵送|0|'''


def url(repo, path):
    return 'https://raw.githubusercontent.com/' + repo + '/' + REVISIONS[repo] + '/' + urllib.parse.quote(path, safe='/')


def fetch(address, target):
    if target.exists():
        return target.read_bytes()
    for attempt in range(3):
        try:
            request = urllib.request.Request(address, headers={'User-Agent': 'agnes-assets/1.0'})
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read(100 * 1024 * 1024 + 1)
            if len(data) > 100 * 1024 * 1024:
                raise ValueError('Asset exceeds 100 MiB cap')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            return data
        except Exception:
            if attempt == 2:
                raise


def source_record(key):
    repo, license_id, author = SOURCES[key]
    folder = SOURCE / key
    data = fetch(url(repo, 'LICENSE'), folder / 'LICENSE')
    r = dict(id=key, repo=repo, url='https://github.com/' + repo, commit=REVISIONS[repo],
             author=author, license=license_id,
             licenseUrl='https://github.com/' + repo + '/blob/' + REVISIONS[repo] + '/LICENSE',
             licensePath=str((folder / 'LICENSE').relative_to(ROOT)),
             licenseSha256=hashlib.sha256(data).hexdigest(),
             retrievedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
             evidence='Pinned upstream LICENSE inspected; repository describes supplied CAD assets.')
    (folder / 'source.json').write_text(json.dumps(r, ensure_ascii=False, indent=2))
    return r


def asset_record(row):
    aid, key, upstream_path, name, category, use, hero, material = row.split('|')
    repo, license_id, author = SOURCES[key]
    folder = CATALOG / aid
    path = folder / ('source' + Path(upstream_path).suffix.lower())
    data = fetch(url(repo, upstream_path), path)
    archive = None
    if path.suffix == '.zip':
        with zipfile.ZipFile(path) as z:
            members = [x for x in z.infolist() if x.filename.lower().endswith(('.step', '.stp')) and x.file_size < 100 * 1024 * 1024]
            print('ZIP_MEMBERS', [(x.filename, x.file_size) for x in members], flush=True)
            selected = next((x for x in members if x.filename == 'Gripper_STEP/Gripper_main_body.STEP'), None)
            if selected is None:
                raise ValueError('Verified ZIP member is absent')
            archive = (str(path.relative_to(ROOT)), selected.filename)
            data = z.read(selected)
            path = folder / 'source.step'
            path.write_bytes(data)
    fmt = path.suffix[1:].upper()
    if fmt in ('STEP', 'STP') and b'ISO-10303-21' not in data[:500]:
        raise ValueError('STEP signature missing')
    if data.startswith(b'version https://git-lfs.github.com'):
        raise ValueError('Git LFS pointer instead of CAD')
    existing = json.loads((folder / 'metadata.json').read_text()) if (folder / 'metadata.json').exists() else {}
    r = dict(id=aid, name=name, category=category, material=material or None,
             summary=name + '，来自 ' + repo + ' 的公开机械设计。', useCase=use,
             hero=hero == '1', sourceType='public-open-hardware',
             sourceUrl='https://github.com/' + repo + '/blob/' + REVISIONS[repo] + '/' + urllib.parse.quote(upstream_path, safe='/'),
             downloadUrl=url(repo, upstream_path), sourceProject=key, author=author,
             license=license_id, licenseUrl='https://github.com/' + repo + '/blob/' + REVISIONS[repo] + '/LICENSE',
             licensePath='assets/sources/' + key + '/LICENSE', format=fmt,
             localPath=str(path.relative_to(ROOT)), sizeBytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
             downloadedAt=existing.get('downloadedAt', datetime.datetime.now(datetime.timezone.utc).isoformat()),
             upstreamCommit=REVISIONS[repo], geometryOrigin='downloaded-original',
             verificationStatus='downloaded-signature-checked; CAD/mesh validation pending',
             manufacturingHistory=None, inventoryQuantity=None,
             notes='公开机械资产；未声称本企业生产过，未生成企业库存或历史。')
    if archive:
        r.update(archivePath=archive[0], archiveMember=archive[1])
    for key in ('alternateCadPath', 'alternateCadSha256', 'alternateCadSourceUrl', 'alternateCadNote',
                'assemblyCompleteness', 'fileValidation', 'previewPath', 'previewSha256', 'previewSourceUrl',
                'previewDownloadedAt', 'previewNote', 'previewValidation', 'archiveSha256', 'archiveSizeBytes'):
        if key in existing:
            r[key] = existing[key]
    # Fixed source bytes retain their downstream verified previews on reacquisition.
    if existing.get('sha256') == r['sha256']:
        for key, value in existing.items():
            r.setdefault(key, value)
        r['verificationStatus'] = existing.get('verificationStatus', r['verificationStatus'])
    (folder / 'metadata.json').write_text(json.dumps(r, ensure_ascii=False, indent=2))
    print('DOWNLOADED', aid, len(data), flush=True)
    return r


if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(7) as pool:
        sources = list(pool.map(source_record, SOURCES))
    (SOURCE / 'registry.json').write_text(json.dumps(sources, ensure_ascii=False, indent=2))
    result, failures = [], []
    rows = ROWS.splitlines()
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        futures = {pool.submit(asset_record, row): row.split('|')[0] for row in rows}
        for future in concurrent.futures.as_completed(futures):
            try:
                result.append(future.result())
            except Exception as error:
                failures.append(dict(id=futures[future], error=str(error)))
                print('FAILED', futures[future], str(error), flush=True)
    ordering = {row.split('|')[0]: i for i, row in enumerate(rows)}
    result.sort(key=lambda x: ordering[x['id']])
    (CATALOG / 'catalog.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (SOURCE / 'download-errors.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2))
    print('DONE', len(result), 'ERRORS', failures, flush=True)
