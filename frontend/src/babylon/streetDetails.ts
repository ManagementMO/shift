import type { Scene } from '@babylonjs/core/scene'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Batch, bounds, centroid, hash01, type RGB } from './geometry'
import { meshFromBatch, vertexColorMaterial } from './city'
import { pointInRing, type TreePlacement } from './details'
import { buildVegetation } from './vegetation'
import type { WorldData } from './worldData'

export function buildStreetDetails(scene: Scene, world: WorldData): Mesh[] {
  const focus = world.landmarks.find(l => l.kind === 'cn_tower') ?? world.venue
  const nearby = (x: number, z: number) => Math.hypot(x - focus.x, z - focus.z) < 1550
  const grids = new Map<string, { stone: Batch; metal: Batch; paint: Batch; timber: Batch }>()
  const cell = (x: number, z: number) => {
    const key = `${Math.floor(x / 400)}:${Math.floor(z / 400)}`
    let value = grids.get(key)
    if (!value) { value = { stone: new Batch(), metal: new Batch(), paint: new Batch(), timber: new Batch() }; grids.set(key, value) }
    return value
  }
  const box = (b: Batch, x: number, z: number, sx: number, sz: number, y: number, h: number, c: RGB) => b.extrude([x-sx,z-sz,x+sx,z-sz,x+sx,z+sz,x-sx,z+sz], undefined, y, y+h, c, c)
  const buildings = world.buildings.filter(b => { const c = centroid(b.ring); return nearby(c[0], c[1]) }).map(b => ({ ring: b.ring, box: bounds(b.ring) }))
  const free = (x: number, z: number) => !buildings.some(b => x > b.box[0]-2 && x < b.box[2]+2 && z > b.box[1]-2 && z < b.box[3]+2 && pointInRing(x,z,b.ring)) && !world.water.some(w => pointInRing(x,z,w.ring) && !w.holes?.some(h => pointInRing(x,z,h)))
  const trees: TreePlacement[] = []
  const used = new Set<string>()
  for (const r of world.roads) {
    if (r.kind !== 'road' || !r.name || !r.lanes?.length || r.speed > 20 || r.id.startsWith(':')) continue
    const shape = r.shape
    if (!nearby(shape[0], shape[1])) continue
    const batch = cell(shape[0], shape[1])
    for (const lane of r.lanes.filter(l => l.allow.length === 1 && l.allow[0] === 'ped')) {
      batch.stone.ribbon(lane.shape, lane.w + 0.7, 0.29, [0.68, 0.66, 0.58])
    }
    const car = r.lanes.filter(l => l.allow.includes('car') || l.allow.includes('bus'))
    for (const lane of car) {
      const s = lane.shape
      if (s.length < 4) continue
      for (const end of [false, true]) {
        const i = end ? s.length - 2 : 0, j = end ? i - 2 : 2
        const dx = s[j] - s[i], dz = s[j+1] - s[i+1], length = Math.hypot(dx,dz)
        if (length < 24) continue
        for (let t=3; t<7; t+=1) {
          const x=s[i]+dx/length*t, z=s[i+1]+dz/length*t, width=lane.w*0.4
          batch.paint.ribbon([x-dz/length*width,z+dx/length*width,x+dz/length*width,z-dx/length*width],0.48,0.6,[0.84,0.82,0.72])
        }
      }
    }
    for (const lane of r.lanes.filter(l => l.allow.length === 1 && l.allow[0] === 'ped')) {
      for (let i=0; i+3<lane.shape.length; i+=2) {
        const ax=lane.shape[i], az=lane.shape[i+1], dx=lane.shape[i+2]-ax, dz=lane.shape[i+3]-az, len=Math.hypot(dx,dz)
        for (let d=16; d<len-10; d+=28) {
          const x=ax+dx/len*d, z=az+dz/len*d
          const key=`${Math.round(x/10)}:${Math.round(z/10)}`
          if (used.has(key) || !free(x,z)) continue
          used.add(key)
          const b=cell(x,z), h=hash01(key)
          if (h>0.3) {
            trees.push({x,z,scale:0.8+h*0.35,shade:h})
            box(b.stone,x,z,1.35,1.35,0.34,0.08,[0.4,0.42,0.34])
          } else {
            b.metal.lathe(x,z,[[0.13,0.4],[0.09,7.2]],[0.24,0.26,0.24],6,1)
            box(b.metal,x+0.6,z,0.8,0.18,7.1,0.2,[0.27,0.3,0.29])
          }
        }
      }
    }
  }
  for (const line of world.rail) {
    if (!nearby(line[0],line[1])) continue
    const b=cell(line[0],line[1])
    b.stone.ribbon(line,3.2,0.61,[0.41,0.4,0.36])
    for (let i=0; i+3<line.length; i+=2) {
      const ax=line[i],az=line[i+1],dx=line[i+2]-ax,dz=line[i+3]-az,len=Math.hypot(dx,dz)
      if (len<0.1) continue
      const nx=-dz/len,nz=dx/len
      for(const side of [-0.72,0.72]) b.metal.ribbon([ax+nx*side,az+nz*side,ax+dx+nx*side,az+dz+nz*side],0.12,0.72,[0.64,0.64,0.58])
      for(let d=0;d<len;d+=2.5) {
        const x=ax+dx*d/len,z=az+dz*d/len
        b.timber.ribbon([x-nx*1.25,z-nz*1.25,x+nx*1.25,z+nz*1.25],0.32,0.68,[0.32,0.28,0.23])
      }
    }
  }
  for(const stop of world.stops) {
    if(!nearby(stop.x,stop.z)) continue
    const {x,z}=stop,b=cell(x,z)
    box(b.stone,x,z,2.8,1.1,0.4,0.16,[0.77,0.76,0.69])
    for(const dx of [-2.4,2.4]) box(b.metal,x+dx,z,0.09,0.09,0.5,2.8,[0.31,0.33,0.3])
    box(b.metal,x,z,2.8,1.1,3.2,0.16,[0.38,0.44,0.42])
    box(b.timber,x,z,1.6,0.27,1,0.15,[0.54,0.4,0.25])
  }
  // Follow the pack's real shoreline. Skip the pack boundary and any segment without clear land beside it.
  const [x0,z0,x1,z1] = world.crs.bounds_world
  for (const water of world.water) {
    const ring=water.ring
    for(let i=0;i<ring.length;i+=2) {
      const j=(i+2)%ring.length, ax=ring[i],az=ring[i+1],dx=ring[j]-ax,dz=ring[j+1]-az,len=Math.hypot(dx,dz)
      if(len<1) continue
      const nx=-dz/len,nz=dx/len
      for(let d=0;d<len;d+=12) {
        const reach=Math.min(12,len-d), x=ax+dx/len*(d+reach/2),z=az+dz/len*(d+reach/2)
        if(!nearby(x,z) || z>focus.z || x<x0+12 || x>x1-12 || z<z0+12 || z>z1-12) continue
        const side=free(x+nx*4,z+nz*4)?1:free(x-nx*4,z-nz*4)?-1:0
        if(!side) continue
        const b=cell(x,z), ox=nx*side,oz=nz*side
        const edge=[ax+dx/len*d,az+dz/len*d,ax+dx/len*(d+reach),az+dz/len*(d+reach)]
        b.stone.ribbon(edge,0.9,0.32,[0.69,0.68,0.6])
        const walk=edge.map((v,k)=>v+(k%2?oz:ox)*2.5)
        if(free(walk[0],walk[1]) && free(walk[2],walk[3])) b.stone.ribbon(walk,4,0.26,[0.62,0.6,0.51])
        b.metal.lathe(x+ox,z+oz,[[0.15,0.3],[0.12,1.05]],[0.29,0.32,0.3],6,1)
        if(free(x+ox*5.5,z+oz*5.5)) {
          const bx=x+ox*5.5,bz=z+oz*5.5
          b.timber.ribbon([bx-dx/len*1.4,bz-dz/len*1.4,bx+dx/len*1.4,bz+dz/len*1.4],0.55,0.8,[0.53,0.4,0.26])
          for(const s of [-1,1]) box(b.metal,bx+dx/len*s,bz+dz/len*s,0.12,0.2,0.3,0.5,[0.27,0.3,0.28])
        }
      }
    }
  }
  const meshes: Mesh[]=[]
  const material=vertexColorMaterial('street-details',scene,0.04)
  for(const [key,batches] of grids) for(const [kind,b] of Object.entries(batches)) {
    if(b.isEmpty()) continue
    const mesh=meshFromBatch(`streets-${key}-${kind}`,b,scene,material)
    mesh.receiveShadows=true
    meshes.push(mesh)
  }
  const foliage=vertexColorMaterial('street-foliage',scene,0.015)
  for(const mesh of buildVegetation(scene,trees,foliage)) { mesh.name=`street-${mesh.name}`; meshes.push(mesh) }
  return meshes
}
