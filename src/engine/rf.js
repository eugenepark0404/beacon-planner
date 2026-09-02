// ---------------------------------------------------------------------------
//  rf.js
//  비콘 제원 · 전파 모델 · 측위 기하 품질(HDOP)
//
//  RSSI = 기준세기(1m) + Tx차 - 10·n·log₁₀(d) - Σ(벽 감쇠) - 층수×슬래브 감쇠
//
//  ⚠️ 여기 숫자들은 2.4 GHz 실내 전파의 일반적인 문헌값이지 롯데몰 광교의
//     실측값이 아니다. positioningThresholdDbm 을 5 dB 만 바꿔도 커버리지가
//     30% → 95% 로 뒤집힌다. 반드시 현장 캘리브레이션으로 교체할 것.
// ---------------------------------------------------------------------------

/** 기본 비콘 제원 (Minew i3 기준값). */
export function defaultRf() {
  return {
    model: 'Minew i3',
    txPowerDbm: 4,               // 송신 출력. i3 는 -30 ~ +4 dBm
    measuredPower1mAt0dBm: -59,  // Tx 0 dBm 일 때 1 m 지점 RSSI
    advIntervalMs: 500,
    batteryMonths: 24,
    unitCost: 15000,             // 비콘 1개 단가 (원)

    pathLossExponent: 2.5,       // 개활 2.0~2.2 / 일반 몰 통로 2.5 / 매장 밀집 3.0+
    structuralLossDb: 12,        // 콘크리트 구조벽
    partitionLossDb: 4,          // 경량 칸막이
    glassLossDb: 2,
    slabLossDb: 20,              // 층간 슬래브 1개 관통

    detectThresholdDbm: -95,     // 이보다 세면 "검출됨"
    positioningThresholdDbm: -85 // 이보다 세야 "측위에 쓸 수 있음"
  };
}

/** 현재 Tx 출력에서의 1 m 기준 RSSI. */
export function measuredPower1m(rf) {
  return rf.measuredPower1mAt0dBm + rf.txPowerDbm;
}

/** 기본 최적화 설정. */
export function defaultSettings() {
  return {
    evalStepM: 2.0,
    candidateStepM: 4.0,
    mountHeightM: 3.0,
    receiverHeightM: 1.2,

    minVisible: 3,
    maxHdop: 6,
    targetCoverage: 0.95,
    maxBeaconsPerFloor: 120,
    maxRangeM: 40,
    minSeparationM: 5,

    seedVerticalCores: true,
    seedEntrances: true,
    // 임대매장 내부에도 설치할 수 있는가. 보통 공용부만 시공 가능하므로 기본 false
    allowInsideStores: false
  };
}

/**
 * 비콘 b 가 (rxFloor, [x,z]) 지점에서 관측되는 RSSI (dBm).
 * plan 은 FloorPlan, set 은 설정.
 */
export function rssi(plan, beacon, rxFloor, rxPos, rf, set) {
  const lv = plan.floorLevels;
  const by = lv[beacon.floor] + beacon.height;
  const ry = lv[rxFloor] + set.receiverHeightM;

  const dx = beacon.x - rxPos[0], dz = beacon.z - rxPos[1];
  const dxz = Math.sqrt(dx * dx + dz * dz);
  const dy = by - ry;
  let d = Math.sqrt(dxz * dxz + dy * dy);
  if (d < 1) d = 1;

  const txDelta = (beacon.txPowerDbm ?? rf.txPowerDbm) - rf.txPowerDbm;
  let r = measuredPower1m(rf) + txDelta - 10 * rf.pathLossExponent * Math.log10(d);

  const gap = Math.abs(beacon.floor - rxFloor);
  const bp = [beacon.x, beacon.z];
  if (gap > 0) {
    r -= gap * rf.slabLossDb;
    // 다른 층이면 벽 감쇠는 비콘 층 기준으로 근사
    r -= plan.wallLossDb(beacon.floor, bp, rxPos, rf) * 0.5;
  } else {
    r -= plan.wallLossDb(rxFloor, bp, rxPos, rf);
  }
  return r;
}

/**
 * 가시 비콘들의 기하학적 배치 품질(HDOP). 작을수록 좋다.
 * 일직선에 가까우면 발산한다 → 삼변측량이 불안정하다는 뜻.
 * HDOP = √(trace((HᵀH)⁻¹)), H 의 각 행은 측정점→비콘 단위벡터.
 */
export function hdop(p, visible) {
  if (visible.length < 3) return Infinity;
  let a = 0, b = 0, c = 0;
  for (const v of visible) {
    const dx = v[0] - p[0], dz = v[1] - p[1];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len;
    a += ux * ux; b += ux * uz; c += uz * uz;
  }
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-6) return Infinity;
  const tr = (a + c) / det;
  if (tr <= 0) return Infinity;
  return Math.sqrt(tr);
}

/** 벽이 없다고 볼 때 이 RSSI 가 나오는 거리 (m). 감도 파악용. */
export function rangeAt(rf, dbm) {
  return Math.pow(10, (measuredPower1m(rf) - dbm) / (10 * rf.pathLossExponent));
}
