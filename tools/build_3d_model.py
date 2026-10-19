#!/usr/bin/env python3
"""Trace the dark architectural strokes in Grainger's bundled floor plans.

This makes an approximate cutaway, not a surveyed BIM. Printed room labels are
masked using the authored label coordinates; small text components are removed.
The remaining raster wall contours retain holes and door gaps. Heights are
illustrative. Navigation continues to use the separately verified route graph.
Run after build_graph.py: python3 tools/build_3d_model.py (requires Pillow).
"""
from collections import defaultdict, deque
from pathlib import Path
import json
import math
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'pkgbc231600/ui/react/public/plans'
OUTPUT = ROOT / 'pkgbc231600/ui/react/src/assets/grainger-3d.json'
GRID = 2
# Approximate outer footprint, shared image coordinate system. Courtyard and
# atrium openings are represented explicitly; this is a cutaway floor slab.
OUTLINE = [(85,390),(85,95),(180,95),(180,40),(245,40),(320,65),(390,130),
 (430,230),(430,310),(590,310),(590,190),(1150,190),(1150,300),(1200,300),
 (1200,230),(1250,145),(1360,65),(1420,50),(1480,65),(1550,125),(1590,230),
 (1615,300),(1615,430),(1530,530),(1630,585),(1630,1055),(1600,1390),
 (1510,1465),(1340,1500),(1340,1400),(1260,1400),(1260,1380),(1340,1380),
 (1340,980),(1210,980),(1190,910),(990,910),(990,1000),(855,1050),
 (855,1470),(605,1470),(580,1390),(590,1240),(430,1240),(430,1300),
 (350,1300),(350,1230),(85,1230),(85,680),(85,510),(430,510),(430,390)]
OPENINGS = {1: [], 2: [[(435,510),(595,510),(595,935),(435,935)]],
 3: [[(435,640),(595,640),(595,765),(435,765)]]}


def area(points):
    return sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points, points[1:]+points[:1]))/2


def inside(point, polygon):
    x,y=point; result=False
    for a,b in zip(polygon, polygon[1:]+polygon[:1]):
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            result=not result
    return result


def simplify(points, epsilon=1.2):
    """Iterative Douglas-Peucker; geometry here is visual only, never routing."""
    chain=points+[points[0]]; keep={0,len(chain)-1}; stack=[(0,len(chain)-1)]
    while stack:
        start,end=stack.pop(); a,b=chain[start],chain[end]
        dx,dy=b[0]-a[0],b[1]-a[1]; length=math.hypot(dx,dy)
        best,index=0,None
        for i in range(start+1,end):
            p=chain[i]
            distance=abs(dy*(p[0]-a[0])-dx*(p[1]-a[1]))/length if length else math.dist(p,a)
            if distance>best: best,index=distance,i
        if best>epsilon:
            keep.add(index); stack.extend([(start,index),(index,end)])
    return [chain[i] for i in sorted(keep)[:-1]]


def contours(cells):
    outgoing=defaultdict(set)
    for x,y in cells:
        if (x,y-1) not in cells: outgoing[(x,y)].add((x+1,y))
        if (x+1,y) not in cells: outgoing[(x+1,y)].add((x+1,y+1))
        if (x,y+1) not in cells: outgoing[(x+1,y+1)].add((x,y+1))
        if (x-1,y) not in cells: outgoing[(x,y+1)].add((x,y))
    loops=[]; directions={(1,0):0,(0,1):1,(-1,0):2,(0,-1):3}
    while outgoing:
        start=min(outgoing); current=start; previous=None; points=[]
        while True:
            points.append((current[0]*GRID,current[1]*GRID))
            options=outgoing[current]
            if previous is None: nxt=min(options)
            else:
                heading=directions[(current[0]-previous[0],current[1]-previous[1])]
                def priority(p):
                    turn=(directions[(p[0]-current[0],p[1]-current[1])]-heading)%4
                    return {1:0,0:1,3:2,2:3}[turn],p
                nxt=min(options,key=priority)
            options.remove(nxt)
            if not options: del outgoing[current]
            previous,current=current,nxt
            if current==start: break
        if len(points)>=4:
            reduced=simplify(points)
            if len(reduced)>=3 and abs(area(reduced))>=10: loops.append(reduced)
    outers=[p for p in loops if area(p)>0]; holes=[p for p in loops if area(p)<0]
    return [{'outline':p,'holes':[h for h in holes if inside(h[0],p)]} for p in outers]


def build_floor(level, nodes):
    im=Image.open(PUBLIC/f'floor_p{level}.png').convert('RGB')
    mask=Image.new('1',im.size); d=ImageDraw.Draw(mask)
    d.polygon(OUTLINE,fill=1)
    for hole in OPENINGS[level]: d.polygon(hole,fill=0)
    for n in nodes:
        if n['floor']['id']!=f'grainger-f{level}': continue
        if n['kind'] in ('room','restroom'):
            x,y=n.get('labelX',n['imageX']),n.get('labelY',n['imageY'])
            d.rectangle((x-36,y-29,x+36,y+29),fill=0)
        if n['kind'] in ('stairs','elevator'):
            x,y=n['imageX'],n['imageY']; d.rectangle((x-24,y-24,x+24,y+24),fill=0)
    pixels=im.load(); allowed=mask.load(); cells=set()
    for y in range(0,im.height-GRID,GRID):
        for x in range(0,im.width-GRID,GRID):
            if allowed[x,y] and sum(max(pixels[x+dx,y+dy])<95 for dx in range(GRID) for dy in range(GRID))>=2:
                cells.add((x//GRID,y//GRID))
    walls=[]
    while cells:
        start=min(cells); cells.remove(start); component={start}; queue=deque([start])
        while queue:
            x,y=queue.popleft()
            for p in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if p in cells: cells.remove(p); component.add(p); queue.append(p)
        xs=[p[0] for p in component]; ys=[p[1] for p in component]
        if len(component)<22 or max(max(xs)-min(xs),max(ys)-min(ys))*GRID<26: continue
        walls.extend(contours(component))
    print(f'Level {level}: {len(walls)} wall outlines, {sum(len(w["outline"]) for w in walls)} vertices')
    return {'level':level,'floorId':f'grainger-f{level}','outline':OUTLINE,'openings':OPENINGS[level],'walls':walls}


def main():
    nodes=json.loads((ROOT/'pkgbc231600/data/MapNode/MapNode.json').read_text())
    model={'imageWidth':1980,'imageHeight':1530,'wallHeightMeters':2.8,'floorHeightMeters':4.2,
      'description':'Approximate plan-derived cutaway; illustrative heights. Routing uses the authored circulation graph.',
      'floors':[build_floor(level,nodes) for level in (1,2,3)]}
    OUTPUT.write_text(json.dumps(model,separators=(',',':'))+'\n')
    print(f'Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size//1024} KB)')

if __name__=='__main__': main()
