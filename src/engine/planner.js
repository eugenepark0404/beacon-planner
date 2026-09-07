// ---------------------------------------------------------------------------
//  planner.js
//  비콘 배치 최적화 — 두 가지 모드
//
//  ① positioning (측위 모드) — 지하처럼 GPS 가 안 잡히는 층
//     "3중 가시성 + GDOP" 를 목적함수로 층 전체를 덮는다.
//     삼변측량은 비콘이 3개 이상 보여야 성립하고, 그 3개가 일직선에
//     가까우면 해가 발산한다(HDOP 악화). 그래서 "신호가 닿는가" 가 아니라
//     "측위가 되는가" 로 최적화한다.
//
//  ② checkpoint (체크포인트 모드) — 지상처럼 GPS 로 위치가 잡히는 층
//     층간 이동만 판별하면 되므로 엘리베이터·에스컬레이터·비상계단
//     승강장에만 비콘을 둔다. 비용이 한 자릿수로 줄어든다.
//
//  탐욕법은 최대커버리지 문제에서 (1-1/e) ≈ 63% 근사보장이 있는 표준 기법이다.
// ---------------------------------------------------------------------------

import { rssi, hdop } from './rf.js';

// ===========================================================================
//  ① 측위 모드
// ===========================================================================

export function planPositioning(plan, floor, rf, set, fixedBeacons = []) {
  const res = emptyResult(plan, floor, set, 'positioning');
  const evalPts = plan.walkableGrid(floor, set.evalStepM);
  res.evalPoints = evalPts.length;
  res.walkableAreaM2 = evalPts.length * set.evalStepM * set.evalStepM;
  if (evalPts.length === 0) return res;

  const cands = buildCandidates(plan, floor, set);
  const rangeSq = set.maxRangeM * set.maxRangeM;
  for (const c of cands) fillCoverage(plan, c, floor, evalPts, rf, set, rangeSq);

  const n = evalPts.length;
  const visCount = new Int32Array(n);
  const visPos = Array.from({ length: n }, () => []);
  const bestRssi = new Float64Array(n).fill(-999);

  const chosen = [];

  // 사용자가 고정한 비콘 먼저 반영 — 이격 제약을 적용하지 않는다
  for (const fb of fixedBeacons) {
    if (fb.floor !== floor) continue;
    const c = { pos: [fb.x, fb.z], mandatory: true, tag: '고정' };
    fillCoverage(plan, c, floor, evalPts, rf, set, rangeSq);
    apply(c, visCount, visPos, bestRssi);
    chosen.push(c);
  }

  // 필수 시드(수직동선·출입구). 에스컬레이터 상행/하행처럼 1~2 m 밖에
  // 안 떨어진 시드가 있으므로 여기서도 최소 이격을 지킨다.
  const sepSq = set.minSeparationM * set.minSeparationM;
  for (const c of cands) {
    if (!c.mandatory) continue;
    if (chosen.length >= set.maxBeaconsPerFloor) break;
    if (tooClose(c.pos, chosen, sepSq)) continue;
    apply(c, visCount, visPos, bestRssi);
    chosen.push(c);
  }

  const pool = cands.filter((c) => !c.mandatory);

  let reachedTarget = coverage(visCount, set.minVisible) >= set.targetCoverage;
  while (chosen.length < set.maxBeaconsPerFloor) {
    if (coverage(visCount, set.minVisible) >= set.targetCoverage) { reachedTarget = true; break; }

    let best = null, bestGain = 0;
    for (let i = pool.length - 1; i >= 0; i--) {
      const c = pool[i];
      if (tooClose(c.pos, chosen, sepSq)) { pool.splice(i, 1); continue; }
      const g = gain(c, evalPts, visCount, visPos, set);
      if (g > bestGain) { bestGain = g; best = c; }
    }
    if (!best || bestGain <= 0.0001) break;

    apply(best, visCount, visPos, bestRssi);
    chosen.push(best);
    pool.splice(pool.indexOf(best), 1);
  }
  res.budgetBound = !reachedTarget && chosen.length >= set.maxBeaconsPerFloor;

  summarize(res, evalPts, visCount, visPos, bestRssi, set);

  const pre = plan.floorNames[floor];
  res.beacons = chosen.map((c, i) => ({
    id: `${pre}-${String(i + 1).padStart(2, '0')}`,
    floor,
    x: round3(c.pos[0]),
    z: round3(c.pos[1]),
    height: set.mountHeightM,
    txPowerDbm: rf.txPowerDbm,
    locked: c.tag === '고정',
    role: c.tag === '고정' ? 'fixed' : (c.mandatory ? 'core' : 'grid')
  }));
  return res;
}

// ===========================================================================
//  ② 체크포인트 모드
// ===========================================================================

/**
 * 이 코어가 floor 층에서 사람이 타고 내리는 지점 = 축의 중앙.
 *
 * 왜 층에 따라 안 움직이는가:
 * 도면의 (a→b) 축은 "한 개 층을 오르는 한 구간"의 평면 footprint 이고,
 * floorLo~floorHi 를 잇는 코어는 그 구간이 같은 자리에 층수만큼 겹쳐 쌓인
 * 형태다(유니티 빌더도 f = lo..hi-1 로 같은 축 위에 한 구간씩 만든다).
 * 즉 어느 층에서 보든 승강장은 축의 양 끝에 있고, 평면 위치는 층과 무관하다.
 *
 * 예전에는 층 번호로 축 위를 보간했는데, 그러면 14 m 짜리 축을 5개 층이
 * 나눠 가져서 상층 체크포인트가 승강장이 아니라 에스컬레이터 한복판에
 * 찍혔다. 중앙점은 양쪽 승강장에서 각각 7 m 로, 포착반경(15~30 m) 안에
 * 두 승강장이 모두 들어온다.
 */
export function landingPoint(core, floor) {
  return [(core.ax + core.bx) * 0.5, (core.az + core.bz) * 0.5];
}

export function planCheckpoints(plan, floor, rf, set, fixedBeacons = []) {
  const res = emptyResult(plan, floor, set, 'checkpoint');
  const evalPts = plan.walkableGrid(floor, set.evalStepM);
  res.evalPoints = evalPts.length;
  res.walkableAreaM2 = evalPts.length * set.evalStepM * set.evalStepM;

  const sepSq = set.minSeparationM * set.minSeparationM;
  const chosen = [];

  for (const fb of fixedBeacons) {
    if (fb.floor !== floor) continue;
    chosen.push({ pos: [fb.x, fb.z], tag: '고정', type: fb.coreType || 'Fixed', cores: [] });
  }

  // 이 층을 지나는 모든 수직동선에 하나씩.
  // 에스컬레이터 상행/하행 쌍은 1.5 m 밖에 안 떨어져 있어서
  // 최소 이격 규칙이 알아서 한 개로 합쳐준다 (= 승강장 1곳당 1개).
  const cores = plan.cores
    .map((c, i) => ({ core: c, index: i }))
    .filter(({ core }) => floor >= core.floorLo && floor <= core.floorHi);

  // 엘리베이터 → 계단 → 에스컬레이터 순으로 우선 배치한다.
  // 엘리베이터는 층간 이동이 가장 확실한 신호이므로 이격 경쟁에서 이겨야 한다.
  const order = { Elevator: 0, Stair: 1, Escalator: 2 };
  cores.sort((a, b) => order[a.core.type] - order[b.core.type]);

  const offPlan = [];
  for (const { core, index } of cores) {
    const raw = landingPoint(core, floor);
    let p = pushToWalkable(plan, floor, raw);
    let flagged = false;
    if (!p) {
      // 승강장이 도면상 BOH 안으로 잡히는 경우가 있다 (특히 4F).
      // 체크포인트를 통째로 빠뜨리는 것보다는 원래 승강장 자리에 두고
      // 도면 확인이 필요하다고 표시하는 편이 낫다.
      p = raw;
      flagged = true;
      offPlan.push({ index, type: core.type, x: round3(raw[0]), z: round3(raw[1]) });
    }

    const near = nearestChosen(p, chosen);
    if (near && near.d2 < sepSq) {
      // 같은 승강장 홀 — 이미 놓은 체크포인트가 이 코어도 함께 담당한다
      near.item.cores.push(index);
      if (!near.item.types.includes(core.type)) near.item.types.push(core.type);
      continue;
    }
    chosen.push({ pos: p, tag: core.type, types: [core.type], cores: [index], offPlan: flagged });
  }
  res.offPlanCores = offPlan;

  const pre = plan.floorNames[floor];
  res.beacons = chosen.map((c, i) => ({
    id: `${pre}-CP${String(i + 1).padStart(2, '0')}`,
    floor,
    x: round3(c.pos[0]),
    z: round3(c.pos[1]),
    height: set.mountHeightM,
    txPowerDbm: rf.txPowerDbm,
    locked: c.tag === '고정',
    role: 'checkpoint',
    // 한 체크포인트가 엘리베이터+계단처럼 여러 코어를 함께 담당할 수 있다
    coreType: c.types ? c.types.join('+') : c.tag,
    coreTypes: c.types || [c.tag],
    coreIds: c.cores,
    offPlan: !!c.offPlan
  }));

  // 이 층의 어떤 수직동선 종류가 담당되고 있는지
  const served = new Set();
  for (const b of res.beacons) for (const t of b.coreTypes) served.add(t);
  res.servedCoreTypes = [...served];
  res.coreCount = cores.length;

  // 체크포인트 모드의 지표는 "층 전체 커버리지" 가 아니라
  // "승강장 앞에서 확실히 잡히는가" 와 "위아래 층과 구분되는가" 이다.
  evaluateCheckpointQuality(plan, res, floor, rf, set, evalPts);
  return res;
}

/**
 * 체크포인트 품질.
 *  · captureAreaM2  이 체크포인트가 검출 임계 이상으로 잡히는 보행 면적
 *  · captureRadiusM 그 면적을 원으로 환산한 반지름
 *  · floorMarginDb  승강장에 서 있을 때, 자기 층 비콘이 위/아래 층 비콘보다
 *                   몇 dB 더 세게 잡히는가. 이 값이 층 판별의 안전마진이다.
 */
function evaluateCheckpointQuality(plan, res, floor, rf, set, evalPts) {
  const detail = [];
  let covered = new Set();

  for (const b of res.beacons) {
    let area = 0;
    for (let i = 0; i < evalPts.length; i++) {
      const r = rssi(plan, b, floor, evalPts[i], rf, set);
      if (r >= rf.detectThresholdDbm) { area += set.evalStepM * set.evalStepM; covered.add(i); }
    }
    const radius = Math.sqrt(area / Math.PI);
    detail.push({
      id: b.id,
      coreType: b.coreType,
      captureAreaM2: Math.round(area),
      captureRadiusM: Math.round(radius * 10) / 10
    });
  }

  res.checkpointDetail = detail;
  res.coverage1 = evalPts.length ? covered.size / evalPts.length : 0;
  res.coverage3 = 0;          // 체크포인트 모드는 삼변측량을 목표하지 않는다
  res.goodHdopRatio = 0;
  res.meanHdop = 0;
  res.meanCaptureRadiusM = detail.length
    ? Math.round((detail.reduce((s, d) => s + d.captureRadiusM, 0) / detail.length) * 10) / 10 : 0;
  res.meanBestRssi = 0;
}

/**
 * 층 판별 정확도 — 체크포인트 방식의 진짜 성패가 걸린 지표.
 *
 * 위험한 실패는 이렇다: 2F 에 서 있는데 바로 아래 1F 체크포인트가
 * 가장 세게 잡히면 1F 로 오판한다. 슬래브 감쇠 20 dB 가 이걸 막아주는지를
 * 층별로 모든 보행 지점에서 실제로 확인한다.
 *
 * 신호가 하나도 안 잡히는 지점은 "판별 불가"로 따로 센다 —
 * 그런 곳에서는 마지막으로 통과한 체크포인트를 그대로 유지하면 되므로
 * 오판보다 훨씬 안전하다.
 */
export function analyzeFloorDiscrimination(plan, results, rf, set) {
  const all = [];
  for (const r of results) for (const b of r.beacons) all.push(b);

  const perFloor = [];
  for (let f = 0; f < plan.floorCount; f++) {
    const pts = plan.walkableGrid(f, set.evalStepM);
    let correct = 0, wrong = 0, silent = 0;
    let marginSum = 0, marginN = 0, worstMargin = Infinity;
    let worstAt = null;

    for (const p of pts) {
      let ownBest = -999, otherBest = -999;
      for (const b of all) {
        const r = rssi(plan, b, f, p, rf, set);
        if (r < rf.detectThresholdDbm) continue;
        if (b.floor === f) { if (r > ownBest) ownBest = r; }
        else if (r > otherBest) otherBest = r;
      }
      if (ownBest < -900 && otherBest < -900) { silent++; continue; }
      if (ownBest < -900) { wrong++; continue; }
      if (ownBest >= otherBest) {
        correct++;
        const m = ownBest - (otherBest < -900 ? rf.detectThresholdDbm : otherBest);
        marginSum += m; marginN++;
        if (m < worstMargin) { worstMargin = m; worstAt = [round3(p[0]), round3(p[1])]; }
      } else wrong++;
    }

    const judged = correct + wrong;
    perFloor.push({
      floor: f,
      floorName: plan.floorNames[f],
      points: pts.length,
      correct, wrong, silent,
      // 신호가 잡힌 지점만 놓고 본 정확도 (진단용)
      accuracy: judged > 0 ? correct / judged : 1,
      // ★ 헤드라인 지표는 이쪽이다.
      //   예전에는 accuracy 만 보여줬는데, 비콘을 지우면 그 자리가 "오판" 이 아니라
      //   "신호 없음(silent)" 으로 빠지면서 분모에서 사라져 100% 가 그대로 유지됐다.
      //   비콘을 아무리 지워도 정확도가 안 떨어지던 원인이다.
      //   전체 보행지점을 분모로 두면 커버리지가 무너지는 즉시 값이 내려간다.
      successRate: pts.length > 0 ? correct / pts.length : 0,
      signalRatio: pts.length > 0 ? judged / pts.length : 0,
      meanMarginDb: marginN > 0 ? Math.round((marginSum / marginN) * 10) / 10 : 0,
      worstMarginDb: isFinite(worstMargin) ? Math.round(worstMargin * 10) / 10 : 0,
      worstAt
    });
  }

  const tc = perFloor.reduce((s, x) => s + x.correct, 0);
  const tw = perFloor.reduce((s, x) => s + x.wrong, 0);
  const ts = perFloor.reduce((s, x) => s + x.silent, 0);
  const tp = perFloor.reduce((s, x) => s + x.points, 0);
  return {
    perFloor,
    overallAccuracy: tc + tw > 0 ? tc / (tc + tw) : 1,   // 신호 잡힌 지점만
    overallSuccess: tp > 0 ? tc / tp : 0,                 // 전체 보행지점 기준 (헤드라인)
    signalRatio: tp > 0 ? (tc + tw) / tp : 0,
    totalWrong: tw,
    totalSilent: ts,
    totalPoints: tp
  };
}

// ===========================================================================
//  공통
// ===========================================================================

/** 사용자가 옮기거나 지운 배치의 품질만 다시 계산한다 (최적화는 하지 않음). */
export function evaluate(plan, floor, beacons, rf, set) {
  const res = emptyResult(plan, floor, set, 'evaluate');
  const evalPts = plan.walkableGrid(floor, set.evalStepM);
  res.evalPoints = evalPts.length;
  res.walkableAreaM2 = evalPts.length * set.evalStepM * set.evalStepM;
  res.beacons = beacons;
  if (evalPts.length === 0) return res;

  const n = evalPts.length;
  const visCount = new Int32Array(n);
  const visPos = Array.from({ length: n }, () => []);
  const bestRssi = new Float64Array(n).fill(-999);
  const rangeSq = set.maxRangeM * set.maxRangeM;

  for (const b of beacons) {
    if (b.floor !== floor) continue;
    for (let i = 0; i < n; i++) {
      const dx = evalPts[i][0] - b.x, dz = evalPts[i][1] - b.z;
      if (dx * dx + dz * dz > rangeSq) continue;
      const r = rssi(plan, b, floor, evalPts[i], rf, set);
      if (r < rf.positioningThresholdDbm) continue;
      visCount[i]++;
      visPos[i].push([b.x, b.z]);
      if (r > bestRssi[i]) bestRssi[i] = r;
    }
  }
  summarize(res, evalPts, visCount, visPos, bestRssi, set);
  return res;
}

function emptyResult(plan, floor, set, mode) {
  return {
    floor,
    floorName: plan.floorNames[floor],
    mode,
    beacons: [],
    evalPoints: 0,
    walkableAreaM2: 0,
    areaM2: plan.areaM2(floor),
    coverage1: 0,
    coverage3: 0,
    goodHdopRatio: 0,
    meanHdop: 0,
    meanBestRssi: 0,
    budgetBound: false
  };
}

function summarize(res, evalPts, visCount, visPos, bestRssi, set) {
  const n = evalPts.length;
  let c1 = 0, c3 = 0, gh = 0, hn = 0, hsum = 0, rsum = 0, rn = 0;
  for (let i = 0; i < n; i++) {
    if (visCount[i] >= 1) c1++;
    if (visCount[i] >= set.minVisible) {
      c3++;
      const h = hdop(evalPts[i], visPos[i]);
      if (isFinite(h)) { hsum += h; hn++; if (h <= set.maxHdop) gh++; }
    }
    if (bestRssi[i] > -900) { rsum += bestRssi[i]; rn++; }
  }
  res.coverage1 = c1 / n;
  res.coverage3 = c3 / n;
  res.goodHdopRatio = gh / n;
  res.meanHdop = hn > 0 ? hsum / hn : 0;
  res.meanBestRssi = rn > 0 ? rsum / rn : 0;
}

function fillCoverage(plan, c, floor, evalPts, rf, set, rangeSq) {
  const pts = [], rs = [];
  const probe = { id: 'probe', floor, x: c.pos[0], z: c.pos[1],
                  height: set.mountHeightM, txPowerDbm: rf.txPowerDbm };
  for (let i = 0; i < evalPts.length; i++) {
    const dx = evalPts[i][0] - c.pos[0], dz = evalPts[i][1] - c.pos[1];
    if (dx * dx + dz * dz > rangeSq) continue;
    const r = rssi(plan, probe, floor, evalPts[i], rf, set);
    if (r < rf.positioningThresholdDbm) continue;
    pts.push(i); rs.push(r);
  }
  c.pts = pts; c.rssi = rs;
}

function apply(c, visCount, visPos, bestRssi) {
  if (!c.pts) return;
  for (let k = 0; k < c.pts.length; k++) {
    const i = c.pts[k];
    visCount[i]++;
    visPos[i].push(c.pos);
    if (c.rssi[k] > bestRssi[i]) bestRssi[i] = c.rssi[k];
  }
}

/**
 * 이 후보를 넣었을 때의 이득.
 * 가시수가 minVisible 에 못 미치는 지점을 채우는 걸 최우선으로,
 * 이미 3개 이상인 지점은 배치 기하가 나쁠 때만 소폭 가산한다.
 */
function gain(c, evalPts, visCount, visPos, set) {
  if (!c.pts) return 0;
  let g = 0;
  for (const i of c.pts) {
    const v = visCount[i];
    if (v < set.minVisible) {
      g += 1.0 + (set.minVisible - v) * 0.25;
    } else {
      const h = hdop(evalPts[i], visPos[i]);
      g += (!isFinite(h) || h > set.maxHdop) ? 0.35 : 0.02;
    }
  }
  return g;
}

function coverage(visCount, minVisible) {
  if (visCount.length === 0) return 1;
  let ok = 0;
  for (let i = 0; i < visCount.length; i++) if (visCount[i] >= minVisible) ok++;
  return ok / visCount.length;
}

function tooClose(p, chosen, sepSq) {
  for (const c of chosen) {
    const dx = p[0] - c.pos[0], dz = p[1] - c.pos[1];
    if (dx * dx + dz * dz < sepSq) return true;
  }
  return false;
}

function nearestChosen(p, chosen) {
  let best = null, bd = Infinity;
  for (const c of chosen) {
    const dx = p[0] - c.pos[0], dz = p[1] - c.pos[1];
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; best = c; }
  }
  return best ? { item: best, d2: bd } : null;
}

/** 벽 안이나 BOH 안이면 근처의 보행가능 지점으로 밀어낸다. */
function pushToWalkable(plan, floor, p) {
  if (plan.isWalkable(floor, p[0], p[1])) return p;
  for (let r = 1.5; r <= 9; r += 1.5) {
    for (let a = 0; a < 12; a++) {
      const th = (a * Math.PI) / 6;
      const q = [p[0] + Math.cos(th) * r, p[1] + Math.sin(th) * r];
      if (plan.isWalkable(floor, q[0], q[1])) return q;
    }
  }
  return null;
}

function buildCandidates(plan, floor, set) {
  const list = [];
  const seen = new Set();

  const tryAdd = (p, mandatory, tag) => {
    const q = pushToWalkable(plan, floor, p);
    if (!q) return;
    if (!mandatory && !set.allowInsideStores && plan.isInsideStore(floor, q[0], q[1])) return;
    const k = `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`;
    if (seen.has(k)) return;
    seen.add(k);
    list.push({ pos: q, mandatory, tag });
  };

  if (set.seedVerticalCores) {
    for (const core of plan.cores) {
      if (floor < core.floorLo || floor > core.floorHi) continue;
      tryAdd(landingPoint(core, floor), true, core.type);
    }
  }
  if (set.seedEntrances) {
    for (const p of plan.pois(floor)) {
      if (p.type !== 'Entrance' && p.type !== 'Info') continue;
      tryAdd([p.x, p.z], true, p.type);
    }
  }
  // 임대매장 안은 우리가 시공할 수 있는 공간이 아니다. 기본은 공용부(통로)만.
  for (const p of plan.walkableGrid(floor, set.candidateStepM)) {
    if (!set.allowInsideStores && plan.isInsideStore(floor, p[0], p[1])) continue;
    tryAdd(p, false, 'grid');
  }

  return list;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ===========================================================================
//  전 층 실행 + 비용
// ===========================================================================

/**
 * floorModes: 층별 모드 배열. 예) ['positioning','checkpoint','checkpoint','checkpoint','checkpoint']
 * 지하는 측위용, 지상은 GPS 와 연동하므로 층간이동 체크포인트만.
 */
export function planAll(plan, rf, set, floorModes, fixedBeacons = []) {
  const results = [];
  for (let f = 0; f < plan.floorCount; f++) {
    const mode = floorModes[f] || 'positioning';
    const fixed = fixedBeacons.filter((b) => b.floor === f && b.locked);
    results.push(mode === 'checkpoint'
      ? planCheckpoints(plan, f, rf, set, fixed)
      : planPositioning(plan, f, rf, set, fixed));
  }
  return {
    results,
    cost: costBreakdown(results, rf),
    floorDiscrimination: analyzeFloorDiscrimination(plan, results, rf, set)
  };
}

/** 비콘 단가 × 개수. 모드별로 나눠서 어디에 돈이 드는지 보이게 한다. */
export function costBreakdown(results, rf) {
  const unit = rf.unitCost || 0;
  const byFloor = results.map((r) => ({
    floor: r.floor,
    floorName: r.floorName,
    mode: r.mode,
    count: r.beacons.length,
    cost: r.beacons.length * unit
  }));
  const positioning = byFloor.filter((f) => f.mode === 'positioning');
  const checkpoint = byFloor.filter((f) => f.mode === 'checkpoint');
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  return {
    unitCost: unit,
    byFloor,
    positioningCount: sum(positioning, 'count'),
    positioningCost: sum(positioning, 'cost'),
    checkpointCount: sum(checkpoint, 'count'),
    checkpointCost: sum(checkpoint, 'cost'),
    totalCount: sum(byFloor, 'count'),
    totalCost: sum(byFloor, 'cost')
  };
}
