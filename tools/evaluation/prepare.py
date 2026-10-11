"""New, independent engineering inputs; no model calls or reference CAD in model input."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, math
root=Path(__file__).resolve().parents[2]
inputs=root/'data/uploads/evaluation-20261009'
inputs.mkdir(parents=True,exist_ok=True)
font_path=next((str(p) for p in [Path('/System/Library/Fonts/Supplemental/Arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.exists()),None)
font=ImageFont.truetype(font_path,24) if font_path else ImageFont.load_default()
small=ImageFont.truetype(font_path,20) if font_path else ImageFont.load_default()
for missing in [False,True]:
    img=Image.new('RGB',(1120,840),'white'); d=ImageDraw.Draw(img)
    d.text((50,28),'EA-V01   FOUR-HOLE MOUNTING PLATE   |   UNITS: mm',fill='#111111',font=font)
    x,y,k=160,160,8
    d.rectangle((x,y,x+72*k,y+48*k),outline='black',width=3)
    for cx in [-24,24]:
        for cy in [-14,14]:
            px=x+(cx+36)*k;py=y+(24-cy)*k;r=4*k
            d.ellipse((px-r,py-r,px+r,py+r),outline='black',width=3)
            d.line((px-r-8,py,px+r+8,py),fill='#777777',width=1)
            d.line((px,py-r-8,px,py+r+8),fill='#777777',width=1)
    def dim(a,b,label,vertical=False):
        d.line((*a,*b),fill='black',width=2)
        if vertical:
            for q in [a,b]:d.line((q[0]-6,q[1],q[0]+6,q[1]),fill='black',width=2)
            d.text((a[0]-40,(a[1]+b[1])/2-12),label,fill='black',font=font)
        else:
            for q in [a,b]:d.line((q[0],q[1]-6,q[0],q[1]+6),fill='black',width=2)
            d.text(((a[0]+b[0])/2-16,a[1]-32),label,fill='black',font=font)
    dim((x,y-55),(x+72*k,y-55),'72')
    dim((x-55,y),(x-55,y+48*k),'48',True)
    dim((x+12*k,y+48*k+52),(x+60*k,y+48*k+52),'48')
    dim((x+72*k+55,y+10*k),(x+72*k+55,y+38*k),'28',True)
    d.text((810,190),'4 x D8 THRU',fill='black',font=font)
    d.text((810,238),'Symmetric about',fill='black',font=small)
    d.text((810,268),'both centerlines',fill='black',font=small)
    d.text((x,620),'FRONT VIEW',fill='black',font=small)
    d.rectangle((x,665,x+72*k,665+8*k),outline='black',width=3)
    if missing:d.text((810,680),'Thickness: ?',fill='black',font=font)
    else:dim((x+72*k+55,665),(x+72*k+55,665+8*k),'8',True)
    d.text((50,794),'Square corners. No chamfers. Orthographic views. Do not infer missing dimensions.',fill='black',font=small)
    img.save(inputs/('EA-V01-B.png' if missing else 'EA-V01-A.png'))
orders=json.loads((root/'assets/demo-enterprise/orders.json').read_text())
base='仅根据所附工程图重建可编辑模型；尺寸必须来自图中标注，不允许根据像素比例补全未标尺寸。调用真实 CAD 工具并核对长度、宽度、厚度、圆孔直径和实体有效性。无法唯一确定时请求缺失资料，不要擅自填数。用中文给出结果。'
draft={'id':'evaluation-draft','name':'待校验安装板','units':'mm','features':[{'id':'base','op':'box','size':[72,48,8]},{'id':'holes','op':'hole','base':'base','diameter':10,'points':[[-24,-14],[-24,14],[24,-14],[24,14]]}],'checks':[{'kind':'circular_edge_diameter','expected':8,'tolerance':0.05},{'kind':'bbox','axis':'z','expected':8,'tolerance':0.05}]}
cases=[{'id':'order','mode':'order_review','prompt':orders[0]['text'],'images':[]},
 {'id':'vision-complete','mode':'reconstruct','prompt':base,'images':[str(inputs/'EA-V01-A.png')]},
 {'id':'vision-missing','mode':'reconstruct','prompt':base,'images':[str(inputs/'EA-V01-B.png')]},
 {'id':'repair-draft','mode':'reconstruct','prompt':base+'\n已有待校验方案如下。请先调用几何工具检验这个候选方案，再读取失败反馈，按图纸修复并重新检验，最多两轮。保留失败记录。\n'+json.dumps(draft,ensure_ascii=False),'images':[str(inputs/'EA-V01-A.png')]}]
for case in cases:(inputs/(case['id']+'.json')).write_text(json.dumps(case,ensure_ascii=False,indent=2))
(root/'evaluation').mkdir(exist_ok=True)
(root/'assets/evaluation').mkdir(exist_ok=True)
(root/'evaluation/reference.json').write_text(json.dumps({'id':'EA-V01','source':'independent dimensioned drawing created for this validation','bbox_mm':[72,48,8],'volume_mm3':72*48*8-4*math.pi*4**2*8,'hole_centres_xy_mm':[[-24,-14],[-24,14],[24,-14],[24,14]],'diameter_mm':8,'missing_case':'thickness intentionally unlabelled; must not infer from rendered pixel scale'},ensure_ascii=False,indent=2))
print(json.dumps({'prepared':len(cases),'inputDirectory':str(inputs)}))

(root/'assets/evaluation/reference.json').write_bytes((root/'evaluation/reference.json').read_bytes())
