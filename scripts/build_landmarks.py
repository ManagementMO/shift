"""Original illustrative Toronto landmarks, authored procedurally in Blender.
/Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/build_landmarks.py
Coordinates: local east, north, up; Blender glTF export and Babylon's LH root handle axes.
"""
import bpy, math, json
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
WORLD=json.loads((ROOT/'var/citypacks/toronto/world.json').read_text())
OUT=ROOT/'frontend/public/assets/city/models'
OUT.mkdir(parents=True,exist_ok=True)

def material(name,color,metal=0,rough=.7):
    m=bpy.data.materials.new(name); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Metallic'].default_value=metal
    p.inputs['Roughness'].default_value=rough
    return m

M={
 'stone':material('Warm limestone',(.63,.59,.49)),
 'concrete':material('Tower concrete',(.72,.71,.65)),
 'white':material('Roof enamel',(.84,.83,.77),.12,.43),
 'glass':material('Blue green glazing',(.12,.22,.25),.45,.19),
 'steel':material('Brushed aluminium',(.43,.47,.46),.55,.38),
 'dark':material('Dark roof membrane',(.2,.23,.23),.1,.76),
 'brick':material('Arena masonry',(.38,.25,.19)),
 'red':material('Antenna red',(.56,.15,.12),.12,.45),
 'copper':material('Weathered copper',(.28,.38,.32),.35,.62),
}

def mesh(name,verts,faces,mat,smooth=False):
    data=bpy.data.meshes.new(name); data.from_pydata(verts,[],faces); data.update()
    obj=bpy.data.objects.new(name,data); bpy.context.collection.objects.link(obj)
    obj.data.materials.append(M[mat])
    if smooth:
        for p in data.polygons: p.use_smooth=True
    return obj

def box(name,x,y,z,w,d,h,mat,angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=(x,y,z+h/2))
    o=bpy.context.object;o.name=name;o.dimensions=(w,d,h);o.rotation_euler[2]=angle
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(M[mat]); return o

def lathe(name,profile,mat,n=64,x=0,y=0):
    vs=[(x+r*math.cos(2*math.pi*i/n),y+r*math.sin(2*math.pi*i/n),z) for r,z in profile for i in range(n)]
    fs=[]
    for j in range(len(profile)-1):
        for i in range(n): fs.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
    fs.extend([tuple(reversed(range(n))),tuple((len(profile)-1)*n+i for i in range(n))])
    return mesh(name,vs,fs,mat,True)

def beam(name,a,b,r,mat,n=8):
    direction=Vector(b)-Vector(a); mid=(Vector(a)+Vector(b))/2
    bpy.ops.mesh.primitive_cylinder_add(vertices=n,radius=r,depth=direction.length,location=mid)
    o=bpy.context.object;o.name=name;o.rotation_euler=direction.to_track_quat('Z','Y').to_euler();o.data.materials.append(M[mat]);return o

def footprint(name,ring,z,h,mat):
    pts=[(ring[i],ring[i+1]) for i in range(0,len(ring),2)]
    if pts[0]==pts[-1]:pts.pop()
    n=len(pts);vs=[(x,y,q) for q in [z,z+h] for x,y in pts]
    fs=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,vs,fs,mat)

def clear():
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def export(name):
    # Keep draw calls proportional to materials rather than architectural detail count.
    for mat in M.values():
        objects=[o for o in bpy.context.scene.objects if o.type=='MESH' and len(o.data.materials) and o.data.materials[0]==mat]
        if not objects:continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(OUT/f'{name}.glb'),export_format='GLB',use_selection=True,export_animations=False,export_cameras=False,export_lights=False)
    print('EXPORTED',name,flush=True)

def local(l):return [v-(l['x'] if i%2==0 else l['z']) for i,v in enumerate(l['ring'])]

clear()
# A three-ribbed concrete shaft and separate glazing bands read correctly from an elevated view.
profile=[(25,0),(21,8),(15,55),(11,190),(8.5,330)]
vs=[]
for r,z in profile:
    for i in range(12):
        a=i*math.pi/6;rr=r if i%4 in [0,1] else r*.54
        vs.append((rr*math.cos(a),rr*math.sin(a),z))
fs=[]
for j in range(len(profile)-1):
    for i in range(12):fs.append((j*12+i,j*12+(i+1)%12,(j+1)*12+(i+1)%12,(j+1)*12+i))
mesh('Three concrete fins',vs,fs,'concrete')
lathe('Observation support',[(8.5,328),(18,332),(30,337),(33,340)],'concrete')
lathe('Restaurant windows',[(33,340),(33,347.2)],'glass')
lathe('Observation deck windows',[(32,348),(31,353)],'glass')
for r,z in [(33.6,340),(33.7,347.3),(32.5,353)]:lathe('Observation rim',[(r,z),(r,z+.9)],'white')
lathe('Observation roof',[(31,354),(25,359),(10,363)],'concrete')
for i in range(64):
    a=i*math.pi/32
    beam('Observation mullion',(33.1*math.cos(a),33.1*math.sin(a),340),(32*math.cos(a),32*math.sin(a),353),.2,'steel',6)
lathe('Upper shaft',[(8.5,361),(6.9,438)],'concrete',32)
lathe('SkyPod',[(7,438),(11,442),(12.5,446),(12,451),(7,456)],'glass',48)
for z,r in [(442,11.3),(451,12.2),(456,7.8)]:lathe('SkyPod rim',[(r,z),(r,z+.7)],'white',48)
lathe('Antenna foot',[(6.4,457),(4.4,474)],'concrete',24)
for i in range(12):
    z=474+i*6.58;r=4.1-(z-474)/79*3.2
    lathe('Antenna section',[(r,z),(max(.35,r-.27),min(553,z+6.58))],'red' if i%2==0 else 'white',16)
for a in [math.pi/6,math.pi/6+2*math.pi/3,math.pi/6+4*math.pi/3]:
    beam('Elevator glazing',(11*math.cos(a),11*math.sin(a),70),(8.9*math.cos(a),8.9*math.sin(a),327),.85,'glass',6)
lathe('Entrance pavilion',[(30,0),(30,5),(23,8)],'stone',48)
export('cn_tower')

clear()
l=next(l for l in WORLD['landmarks'] if l['kind']=='rogers_centre');ring=local(l)
xs=ring[::2];ys=ring[1::2];cx=(max(xs)+min(xs))/2;cy=(max(ys)+min(ys))/2;rx=(max(xs)-min(xs))*.465;ry=(max(ys)-min(ys))*.465
footprint('Stadium base',ring,0,7,'stone')
footprint('Concourse facade',ring,7,23,'concrete')
# Three shallow roof panels, with real seams and glazed perimeter concourses.
N=96;R=20;vs=[]
for j in range(R+1):
    t=j/R*math.pi/2
    for i in range(N):
        a=i/N*2*math.pi
        vs.append((cx+rx*math.cos(t)*math.cos(a),cy+ry*math.cos(t)*math.sin(a),30+46*math.sin(t)))
fs=[]
for j in range(R):
    for i in range(N):fs.append((j*N+i,j*N+(i+1)%N,(j+1)*N+(i+1)%N,(j+1)*N+i))
mesh('Retractable roof panels',vs,fs,'white',True)
for offset in [-.72,-.38,0,.38,.72]:
    x=rx*offset;span=ry*math.sqrt(1-offset**2)*.98
    points=[]
    for i in range(41):
        y=-span+2*span*i/40;z=30+46*math.sqrt(max(0,1-(x/rx)**2-(y/ry)**2))+.85
        points.append((cx+x,cy+y,z))
    for a,b in zip(points,points[1:]):beam('Roof panel rail',a,b,.42,'steel',6)
for i in range(64):
    a=i/64*2*math.pi;x=cx+rx*1.02*math.cos(a);y=cy+ry*1.02*math.sin(a)
    beam('Concourse column',(x,y,2),(x,y,30),.65,'concrete')
    if i%2==0:box('Glazed concourse bay',x,y,10,rx*.065,1,12,'glass',a+math.pi/2)
for z in [7,28]:
    points=[(cx+rx*1.03*math.cos(i*2*math.pi/96),cy+ry*1.03*math.sin(i*2*math.pi/96),z) for i in range(97)]
    for a,b in zip(points,points[1:]):beam('Concourse cornice',a,b,.8,'white',6)
export('rogers_centre')

clear()
l=next(l for l in WORLD['landmarks'] if l['kind']=='union_station');ring=local(l)
footprint('Station wings',ring,0,18,'stone')
xs=ring[::2];ys=ring[1::2];w=min(max(xs)-min(xs),250);d=min(max(ys)-min(ys),100);north=max(ys)-4
box('Great Hall',0,north-24,17,w*.49,35,17,'stone')
box('Great Hall copper roof',0,north-24,34,w*.51,37,2,'copper')
box('Colonnade entablature',0,north,18,w*.85,9,2.4,'stone')
box('Main entrance shadow',0,north-2,2,w*.83,1,14,'glass')
for i in range(23):
    x=-w*.39+i*w*.78/22
    lathe('Doric column',[(.9,1),(.8,2),(.66,15.7),(.9,16.3),(.9,18)],'stone',12,x=x,y=north+2)
    box('Column plinth',x,north+2,.1,2,2,.8,'stone')
for x in [-w*.38,w*.38]:box('Wing roof',x,north-25,18,w*.21,45,1.5,'dark')
# Long barrel-vault shed roofs immediately south of the headhouse.
for k in range(4):
    yy=min(ys)+k*13+9;verts=[]
    for x in [-w*.44,w*.44]:
        for j in range(17):
            a=j/16*math.pi;verts.append((x,yy+6*math.cos(a),12+5*math.sin(a)))
    mesh('Train shed vault',verts,[(j,j+1,j+18,j+17) for j in range(16)],'steel',True)
    for x in [-w*.44,0,w*.44]:
        for j in range(16):
            a=j/16*math.pi;b=(j+1)/16*math.pi
            beam('Shed rib',(x,yy+6*math.cos(a),12+5*math.sin(a)),(x,yy+6*math.cos(b),12+5*math.sin(b)),.18,'white',6)
export('union_station')

clear()
l=next(l for l in WORLD['landmarks'] if l['kind']=='scotiabank_arena');ring=local(l)
footprint('Historic postal building',ring,0,16,'brick')
footprint('Arena upper facade',ring,16,38,'concrete')
xs=ring[::2];ys=ring[1::2];w=(max(xs)-min(xs))*.84;d=(max(ys)-min(ys))*.84
box('Arena metal roof',0,0,38,w,d,4,'steel')
box('Roof plant',0,0,42,w*.46,d*.4,4,'dark')
for i in range(13):
    x=-w*.46+i*w*.92/12
    box('Roof seam',x,0,42,.6,d,.4,'white')
for i in range(16):
    x=-w*.46+i*w*.92/15
    box('North glazing',x,max(ys)+.1,4,w/21,1,9,'glass')
    box('Upper glazing',x,max(ys)+.2,21,w/22,1,12,'glass')
box('Entrance canopy',0,max(ys)+4,13,w*.56,9,.8,'steel')
for x in [-w*.23,w*.23]:beam('Canopy support',(x,max(ys)+6,0),(x,max(ys)+6,13),.55,'steel')
export('scotiabank_arena')
print('All four landmark assets exported.',flush=True)
