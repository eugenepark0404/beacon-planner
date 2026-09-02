// JS 포팅이 C# 원본과 같은 결과를 내는지 대조한다.
// C# 기준값은 mono 로 실제 돌려서 얻은 수치다.
import fs from 'fs';
import { FloorPlan } from '../src/engine/geometry.js';
import { defaultRf, defaultSettings, measuredPower1m, rangeAt } from '../src/engine/rf.js';
import { planPositioning, planCheckpoints, planAll } from '../src/engine/planner.js';

const json = JSON.parse(fs.readFileSync(new URL('../src/data/floorplan.json', import.meta.url), 'utf8'));
const plan = new FloorPlan(json);
const rf = defaultRf();
const set = defaultSettings();

const pct = (v) => (v * 100).toFixed(1) + '%';
const won = (v) => v.toLocaleString('ko-KR') + '원';

// C# 기준값 (mono 실행 결과)
const CSHARP = [
  { name: 'B1', walls: 112, evalPoints: 1612, beacons: 54, cov3: 0.953 },
  { name: '1F', walls: 154, evalPoints: 2356, beacons: 76, cov3: 0.951 },
  { name: '2F', walls: 269, evalPoints: 2536, beacons: 96, cov3: 0.951 },
  { name: '3F', walls: 216, evalPoints: 2638, beacons: 85, cov3: 0.951 },
  { name: '4F', walls: 91,  evalPoints: 1109, beacons: 34, cov3: 0.959 }
];

console.log('===== JS 포팅 대조 검증 (전 층 측위 모드) =====');
console.log(`1m 기준 ${measuredPower1m(rf)} dBm / n=${rf.pathLossExponent} / 측위임계 ${rf.positioningThresholdDbm} dBm`);
console.log(`측위 도달거리(벽 없을 때) ${rangeAt(rf, rf.positioningThresholdDbm).toFixed(1)} m / 검출 ${rangeAt(rf, rf.detectThresholdDbm).toFixed(1)} m\n`);

let allOk = true;
console.log('층   벽(C#/JS)   평가점(C#/JS)   비콘(C#/JS)   3중(C#/JS)        판정');
for (let f = 0; f < plan.floorCount; f++) {
  const ref = CSHARP[f];
  const t0 = Date.now();
  const walls = plan.walls(f).length;
  const r = planPositioning(plan, f, rf, set);
  const ms = Date.now() - t0;

  const wallOk = walls === ref.walls;
  const evalOk = r.evalPoints === ref.evalPoints;
  // 탐욕 선택은 부동소수 순서에 민감하므로 비콘 수는 ±3개까지 동일로 본다
  const bOk = Math.abs(r.beacons.length - ref.beacons) <= 3;
  const cOk = Math.abs(r.coverage3 - ref.cov3) <= 0.02;
  const ok = wallOk && evalOk && bOk && cOk;
  if (!ok) allOk = false;

  console.log(
    `${ref.name.padEnd(4)} ${String(ref.walls).padStart(4)}/${String(walls).padEnd(5)} ` +
    `${String(ref.evalPoints).padStart(6)}/${String(r.evalPoints).padEnd(7)} ` +
    `${String(ref.beacons).padStart(4)}/${String(r.beacons.length).padEnd(6)} ` +
    `${pct(ref.cov3).padStart(6)}/${pct(r.coverage3).padEnd(7)} ` +
    `${ok ? 'OK' : '불일치'}  (${ms}ms)`
  );
}
console.log(allOk ? '\n→ 전 층 일치. JS 포팅이 C# 과 같은 결과를 낸다.\n'
                  : '\n→ !! 불일치 발생 — 포팅을 다시 봐야 한다.\n');

// ---------------------------------------------------------------------------
console.log('===== 실제 운용 구성: 지하=측위 / 지상=체크포인트 =====');
const modes = ['positioning', 'checkpoint', 'checkpoint', 'checkpoint', 'checkpoint'];
const t0 = Date.now();
const { results, cost, floorDiscrimination: fd } = planAll(plan, rf, set, modes);
console.log(`계산 ${Date.now() - t0} ms\n`);

for (const r of results) {
  if (r.mode === 'positioning') {
    console.log(`── ${r.floorName} [측위]  비콘 ${r.beacons.length}개`);
    console.log(`   보행 ${r.walkableAreaM2.toFixed(0)} ㎡ (${(r.walkableAreaM2 / r.beacons.length).toFixed(0)} ㎡/개)`);
    console.log(`   1중 ${pct(r.coverage1)}  3중 ${pct(r.coverage3)}  HDOP≤${set.maxHdop} ${pct(r.goodHdopRatio)} (평균 ${r.meanHdop.toFixed(2)})`);
  } else {
    const byType = {};
    for (const b of r.beacons) byType[b.coreType] = (byType[b.coreType] || 0) + 1;
    console.log(`── ${r.floorName} [체크포인트]  비콘 ${r.beacons.length}개 / 수직동선 ${r.coreCount}개`);
    console.log(`   ` + Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' / '));
    console.log(`   평균 포착반경 ${r.meanCaptureRadiusM} m   검출면적 ${pct(r.coverage1)}`);
    if (r.offPlanCores.length) console.log(`   !! 도면상 BOH 안에 잡힌 승강장 ${r.offPlanCores.length}개 — 좌표 확인 필요`);
  }
}

console.log('\n===== 비용 =====');
console.log(`비콘 단가 ${won(cost.unitCost)}`);
for (const f of cost.byFloor)
  console.log(`  ${f.floorName.padEnd(3)} ${f.mode === 'positioning' ? '측위    ' : '체크포인트'} ${String(f.count).padStart(3)}개  ${won(f.cost).padStart(12)}`);
console.log(`  ${'─'.repeat(40)}`);
console.log(`  지하 측위    ${String(cost.positioningCount).padStart(3)}개  ${won(cost.positioningCost).padStart(12)}`);
console.log(`  지상 체크포인트 ${String(cost.checkpointCount).padStart(3)}개  ${won(cost.checkpointCost).padStart(12)}`);
console.log(`  합계         ${String(cost.totalCount).padStart(3)}개  ${won(cost.totalCost).padStart(12)}`);

// 전 층 측위로 했을 때와 비교
const allPos = planAll(plan, rf, set, Array(5).fill('positioning'));
console.log(`\n(참고) 전 층을 측위 모드로 하면 ${allPos.cost.totalCount}개 / ${won(allPos.cost.totalCost)}`);
console.log(`       지상을 체크포인트로 바꿔서 ${allPos.cost.totalCount - cost.totalCount}개 / ` +
            `${won(allPos.cost.totalCost - cost.totalCost)} 절감`);

// ---------------------------------------------------------------------------
console.log('\n===== 층 판별 정확도 (이 방식의 성패가 걸린 지표) =====');
console.log('층   보행지점  신호있음   정답    오판    정확도   평균마진  최악마진');
for (const d of fd.perFloor) {
  console.log(`${d.floorName.padEnd(4)} ${String(d.points).padStart(7)} ` +
              `${pct(d.signalRatio).padStart(8)} ${String(d.correct).padStart(7)} ` +
              `${String(d.wrong).padStart(7)} ${pct(d.accuracy).padStart(8)} ` +
              `${String(d.meanMarginDb).padStart(8)} dB ${String(d.worstMarginDb).padStart(6)} dB`);
}
console.log(`\n전체 층판별 정확도 ${pct(fd.overallAccuracy)} / 오판 지점 ${fd.totalWrong}개`);
