// ---------------------------------------------------------------------------
//  geometry.js
//  도면(floorplan.json) 을 배치 알고리즘이 쓸 수 있는 형태로 가공한다.
//
//   · isWalkable(floor, p)      이 지점이 사람이 다닐 수 있는 곳인가
//   · walkableGrid(floor, step) 보행가능 격자점
//   · walls(floor)              벽 세그먼트 (구조벽 / 칸막이)
//   · wallLossDb(floor, a, b)   두 점을 잇는 직선이 지나는 벽의 총 감쇠 (dB)
//
//  유니티판 MallGeometry.cs 와 같은 알고리즘·같은 상수를 쓴다.
//  (검증: tools/verify.js 가 C# 결과와 층별 수치를 대조한다)
// ---------------------------------------------------------------------------

const PROBE_DIST = 0.45;   // 매장 전면 판정용 탐침 거리
const CELL_SIZE = 6.0;     // 벽 공간해시 셀 크기 (m)

export const WallKind = { Structural: 0, Partition: 1, Glass: 2 };

// ---- 폴리곤 기본 연산 -------------------------------------------------------

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s * 0.5;
}

export function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/** 광선 교차법. 경계 위의 점은 구현 정의 — 격자 샘플링에서는 문제되지 않는다. */
export function contains(poly, px, pz) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if ((zi > pz) !== (zj > pz)) {
      const t = (pz - zi) / (zj - zi);
      if (px < xi + t * (xj - xi)) inside = !inside;
    }
  }
  return inside;
}

/** 두 선분이 (끝점 제외하고) 실제로 교차하는가. */
function segHit(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-9) return false;
  const u = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const v = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return u > 1e-4 && u < 1 - 1e-4 && v > 1e-4 && v < 1 - 1e-4;
}

const cell = (v) => Math.floor(v / CELL_SIZE);
const key = (x, z) => ((x + 4096) << 20) | (z + 4096);

// ---- 층 캐시 ---------------------------------------------------------------

export class FloorPlan {
  constructor(json) {
    this.raw = json;
    this.floorNames = json.floorNames;
    this.floorLevels = json.floorLevels;
    this.daejangArea = json.daejangArea;
    this.cores = json.cores;
    this._cache = new Array(json.floors.length).fill(null);
  }

  get floorCount() { return this.raw.floors.length; }
  floor(f) { return this.raw.floors[f]; }

  _get(f) {
    if (this._cache[f]) return this._cache[f];
    const src = this.raw.floors[f];
    const c = {
      slab: src.slab,
      boh: src.boh,
      atrium: src.atrium,
      stores: src.stores.map((s) => s.pts),
      storeMeta: src.stores,
      pois: src.pois,
    };

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const v of c.slab) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minZ) minZ = v[1];
      if (v[1] > maxZ) maxZ = v[1];
    }
    c.minX = minX; c.maxX = maxX; c.minZ = minZ; c.maxZ = maxZ;
    c.areaM2 = Math.abs(signedArea(ensureCCW(c.slab)));

    buildWalls(c);
    this._cache[f] = c;
    return c;
  }

  areaM2(f) { return this._get(f).areaM2; }
  walls(f) { return this._get(f).walls; }
  bounds(f) { const c = this._get(f); return { minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ }; }
  pois(f) { return this._get(f).pois; }
  stores(f) { return this._get(f).storeMeta; }

  /** 슬래브 안 && BOH 밖. */
  isWalkable(f, x, z) {
    const c = this._get(f);
    if (!contains(c.slab, x, z)) return false;
    for (const b of c.boh) if (contains(b, x, z)) return false;
    return true;
  }

  isInsideStore(f, x, z) {
    const c = this._get(f);
    for (const s of c.stores) if (contains(s, x, z)) return true;
    return false;
  }

  /** 보행가능 영역을 step 간격 격자로 샘플링. 반환은 [x,z] 배열. */
  walkableGrid(f, step) {
    const c = this._get(f);
    const pts = [];
    for (let x = c.minX + step * 0.5; x < c.maxX; x += step)
      for (let z = c.minZ + step * 0.5; z < c.maxZ; z += step)
        if (this.isWalkable(f, x, z)) pts.push([x, z]);
    return pts;
  }

  /** a→b 직선이 지나는 벽들의 총 감쇠 (dB). 같은 층 기준. */
  wallLossDb(f, a, b, rf) {
    const c = this._get(f);
    let loss = 0;
    const x0 = cell(Math.min(a[0], b[0])), x1 = cell(Math.max(a[0], b[0]));
    const z0 = cell(Math.min(a[1], b[1])), z1 = cell(Math.max(a[1], b[1]));
    const seen = new Set();
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const lst = c.hash.get(key(x, z));
        if (!lst) continue;
        for (const wi of lst) {
          if (seen.has(wi)) continue;
          seen.add(wi);
          const w = c.walls[wi];
          if (!segHit(a, b, w.a, w.b)) continue;
          if (w.kind === WallKind.Structural) loss += rf.structuralLossDb;
          else if (w.kind === WallKind.Glass) loss += rf.glassLossDb;
          else loss += rf.partitionLossDb;
        }
      }
    }
    return loss;
  }
}

// ---- 벽 추출 ---------------------------------------------------------------

function addRing(out, poly, kind) {
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    if (dx * dx + dz * dz < 0.0025) continue;
    out.push({ a, b, kind });
  }
}

function buildWalls(c) {
  const walls = [];

  // 1) 슬래브 외곽 = 외벽 (구조벽)
  addRing(walls, c.slab, WallKind.Structural);

  // 2) BOH 매스 = 구조벽 덩어리
  for (const b of c.boh) addRing(walls, b, WallKind.Structural);

  // 3) 매장 폴리곤 — 통로를 향한 변(전면)은 뚫려 있으므로 제외하고,
  //    다른 매장/BOH 와 맞닿은 변만 칸막이벽으로 넣는다.
  for (const s of c.stores) {
    const poly = ensureCCW(s);
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.05) continue;
      const ux = dx / len, uz = dz / len;
      // 바깥쪽 법선 (CCW 기준 오른쪽)
      const ox = uz, oz = -ux;
      const px = (a[0] + b[0]) * 0.5 + ox * PROBE_DIST;
      const pz = (a[1] + b[1]) * 0.5 + oz * PROBE_DIST;

      let solid = !contains(c.slab, px, pz);
      if (!solid) for (const q of c.boh) if (contains(q, px, pz)) { solid = true; break; }
      if (!solid) for (const q of c.stores) {
        if (q === s) continue;
        if (contains(q, px, pz)) { solid = true; break; }
      }
      if (solid) walls.push({ a, b, kind: WallKind.Partition });
    }
  }

  c.walls = walls;

  // 공간 해시
  c.hash = new Map();
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const x0 = cell(Math.min(w.a[0], w.b[0])), x1 = cell(Math.max(w.a[0], w.b[0]));
    const z0 = cell(Math.min(w.a[1], w.b[1])), z1 = cell(Math.max(w.a[1], w.b[1]));
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = key(x, z);
        let lst = c.hash.get(k);
        if (!lst) { lst = []; c.hash.set(k, lst); }
        lst.push(i);
      }
  }
}
