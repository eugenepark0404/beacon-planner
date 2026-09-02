// ---------------------------------------------------------------------------
//  client.js
//  워커를 Promise 로 감싼다. 화면 쪽에서는 그냥 await 하면 된다.
// ---------------------------------------------------------------------------

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./planner.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, data, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(data) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    // 워커 자체가 죽으면 대기 중인 요청을 전부 실패시킨다 (영원히 매달리지 않게)
    for (const [, p] of pending) p.reject(new Error('계산 워커 오류: ' + e.message));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, payload });
  });
}

export const runPlan = (payload) => call('plan', payload);
export const runEvaluate = (payload) => call('evaluate', payload);
