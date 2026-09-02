// ---------------------------------------------------------------------------
//  planner.worker.js
//  배치 계산을 백그라운드 스레드에서 돌린다.
//
//  전 층 계산이 2~4초 걸리는데, 메인 스레드에서 돌리면 그동안 화면이
//  완전히 얼어붙는다(버튼도 안 눌리고 스크롤도 안 됨). 워커로 빼면
//  계산 중에도 도면을 넘겨보고 층을 바꿀 수 있다.
// ---------------------------------------------------------------------------
import { FloorPlan } from './geometry.js';
import { defaultRf, defaultSettings, rangeAt } from './rf.js';
import {
  planAll, evaluate, costBreakdown, analyzeFloorDiscrimination
} from './planner.js';
import floorplanJson from '../data/floorplan.json';

const plan = new FloorPlan(floorplanJson);

function derived(rf) {
  return {
    positioningRangeM: +rangeAt(rf, rf.positioningThresholdDbm).toFixed(1),
    detectRangeM: +rangeAt(rf, rf.detectThresholdDbm).toFixed(1)
  };
}

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    const rf = { ...defaultRf(), ...(payload?.rf || {}) };
    const set = { ...defaultSettings(), ...(payload?.settings || {}) };
    const modes = payload?.floorModes || plan.floorNames.map(() => 'positioning');
    const t0 = Date.now();

    if (type === 'plan') {
      const out = planAll(plan, rf, set, modes, payload.fixedBeacons || []);
      out.elapsedMs = Date.now() - t0;
      out.derived = derived(rf);
      self.postMessage({ id, ok: true, data: out });
      return;
    }

    if (type === 'evaluate') {
      const beacons = payload.beacons || [];
      const results = [];
      for (let f = 0; f < plan.floorCount; f++) {
        const r = evaluate(plan, f, beacons.filter((b) => b.floor === f), rf, set);
        r.mode = modes[f] || 'positioning';
        results.push(r);
      }
      self.postMessage({
        id, ok: true,
        data: {
          results,
          cost: costBreakdown(results, rf),
          floorDiscrimination: analyzeFloorDiscrimination(plan, results, rf, set),
          elapsedMs: Date.now() - t0,
          derived: derived(rf)
        }
      });
      return;
    }

    throw new Error('알 수 없는 요청: ' + type);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
