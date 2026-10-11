"""Independent check of model-produced STEP, never used to supply model answers."""
import json, sys, math
import cadquery as cq
from pathlib import Path
reference=json.loads((Path(__file__).resolve().parents[2]/'assets/evaluation/reference.json').read_text())
shape=cq.importers.importStep(sys.argv[1]).val()
b=shape.BoundingBox()
measured={'valid':shape.isValid(),'bbox_mm':[b.xlen,b.ylen,b.zlen],'volume_mm3':shape.Volume()}
cylinders=[]
for face in shape.Faces():
    if face.geomType()=='CYLINDER':
        surface=face._geomAdaptor().Cylinder()
        axis=surface.Axis(); origin=axis.Location()
        cylinders.append({'radius':surface.Radius(),'x':origin.X(),'y':origin.Y()})
checks={'valid':measured['valid'],'dimensions':all(abs(a-b)<0.05 for a,b in zip(measured['bbox_mm'],reference['bbox_mm'])),'volume':abs(measured['volume_mm3']-reference['volume_mm3'])<0.1,'four_holes':len(cylinders)==4 and all(abs(c['radius']-reference['diameter_mm']/2)<0.05 for c in cylinders)}
# Centres are compared relative to the part bounding-box centre to ignore harmless origin choices.
xy=sorted([(round(c['x']-(b.xmin+b.xmax)/2,3),round(c['y']-(b.ymin+b.ymax)/2,3)) for c in cylinders])
expected=sorted([tuple(v) for v in reference['hole_centres_xy_mm']])
checks['hole_positions']=len(xy)==4 and all(abs(a-c)<0.05 and abs(b-d)<0.05 for (a,b),(c,d) in zip(xy,expected))
print(json.dumps({'passed':all(checks.values()),'checks':checks,'measured':measured,'cylinders':cylinders,'reference':'assets/evaluation/reference.json'},indent=2))
