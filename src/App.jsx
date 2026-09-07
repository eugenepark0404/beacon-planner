// ---------------------------------------------------------------------------
//  App.jsx — 비콘 배치 추천 프로그램
//
//  흐름
//   ① 비콘 제원 입력      → 좌측 패널
//   ② 도면 입력           → 서버가 롯데몰 광교 도면을 제공 (5개 층)
//   ③ 배치 추천           → [배치 계산] 버튼
//   ④ 커스터마이징        → 캔버스에서 Shift+클릭 추가 / 드래그 이동 / Delete 삭제
//   ⑤ 최종본 저장         → [JSON 저장]
// ---------------------------------------------------------------------------
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import FloorCanvas from './FloorCanvas.jsx';
import { runPlan, runEvaluate } from './engine/client.js';
import { defaultRf, defaultSettings } from './engine/rf.js';
import floorplanJson from './data/floorplan.json';

const pct = (v) => (v * 100).toFixed(1) + '%';
const won = (v) => (v || 0).toLocaleString('ko-KR') + '원';

export default function App() {
  const [plan, setPlan] = useState(null);        // 도면
  const [rf, setRf] = useState(null);            // 비콘 제원
  const [settings, setSettings] = useState(null);
  const [modes, setModes] = useState([]);        // 층별 모드
  const [floor, setFloor] = useState(0);

  const [beacons, setBeacons] = useState([]);    // 현재 배치 (사용자 수정 포함)
  const [results, setResults] = useState(null);
  const [cost, setCost] = useState(null);
  const [discrim, setDiscrim] = useState(null);

  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [showStores, setShowStores] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showRange, setShowRange] = useState(true);
  const [dirty, setDirty] = useState(false);     // 계산 후 손을 댔는가

  // ---- 초기 로드 ----
  // 도면과 기본값은 번들에 들어 있다. 서버가 필요 없다.
  useEffect(() => {
    setPlan(floorplanJson);
    setRf(defaultRf());
    setSettings(defaultSettings());
    // 지하는 측위, 지상은 GPS 와 연동하므로 체크포인트가 기본
    setModes(floorplanJson.floorNames.map((n) => (n.startsWith('B') ? 'positioning' : 'checkpoint')));
  }, []);

  // ---- ③ 배치 계산 ----
  const doPlan = async () => {
    setBusy('배치 계산 중…'); setErr('');
    try {
      const locked = beacons.filter((b) => b.locked);
      const r = await runPlan({ rf, settings, floorModes: modes, fixedBeacons: locked });
      setResults(r.results);
      setCost(r.cost);
      setDiscrim(r.floorDiscrimination);
      setBeacons(r.results.flatMap((x) => x.beacons));
      setDirty(false);
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  // ---- ④ 수정본 재평가 ----
  const doEvaluate = async () => {
    setBusy('재평가 중…'); setErr('');
    try {
      const r = await runEvaluate({ rf, settings, beacons, floorModes: modes });
      setResults(r.results);
      setCost(r.cost);
      setDiscrim(r.floorDiscrimination);
      setDirty(false);
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  // ---- ⑤ 저장 / 불러오기 ----
  const doSave = () => {
    const doc = {
      version: 1,
      building: plan.building,
      savedAt: new Date().toISOString(),
      unitToMeter: plan.unitToMeter,
      floorNames: plan.floorNames,
      floorModes: modes,
      rf, settings, beacons,
      metrics: results ? results.map((r) => ({
        floor: r.floor, floorName: r.floorName, mode: r.mode,
        n: r.beacons.length, walkableAreaM2: r.walkableAreaM2,
        coverage1: r.coverage1, coverage3: r.coverage3,
        goodHdopRatio: r.goodHdopRatio, meanHdop: r.meanHdop
      })) : [],
      cost
    };
    const o = plan.siteOrigin();
    doc.siteOrigin = {
      note: '설치 좌표계 원점 — 건물 외곽 정중앙. X 동서 / Z 남북 / Y 1F 바닥 기준 절대 높이',
      planX: Math.round(o.x * 1000) / 1000,
      planZ: Math.round(o.z * 1000) / 1000,
      spanX: Math.round(o.spanX * 100) / 100,
      spanZ: Math.round(o.spanZ * 100) / 100
    };
    doc.beacons = beacons.map((b) => ({ ...b, site: plan.siteXYZ(b) }));

    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `BeaconPlan_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doLoad = (file) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (d.rf) setRf({ ...rf, ...d.rf });
        if (d.settings) setSettings({ ...settings, ...d.settings });
        if (d.floorModes) setModes(d.floorModes);
        setBeacons(d.beacons || []);
        setResults(null); setDiscrim(null);
        setCost(d.cost || null);
        setDirty(true);
        setErr('');
      } catch (e) { setErr('JSON 을 읽지 못했습니다: ' + e.message); }
    };
    fr.readAsText(file);
  };

  // ---- 비콘 편집 ----
  const moveBeacon = useCallback((id, x, z) => {
    setBeacons((bs) => bs.map((b) => (b.id === id ? { ...b, x, z } : b)));
    setDirty(true);
  }, []);

  const addBeacon = useCallback((x, z) => {
    setBeacons((bs) => {
      const pre = plan.floorNames[floor];
      let n = 1;
      while (bs.some((b) => b.id === `${pre}-M${n}`)) n++;
      const nb = {
        id: `${pre}-M${n}`, floor, x, z,
        height: settings.mountHeightM, txPowerDbm: rf.txPowerDbm,
        locked: true, role: 'manual'
      };
      setSelectedId(nb.id);
      return [...bs, nb];
    });
    setDirty(true);
  }, [floor, plan, settings, rf]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setBeacons((bs) => bs.filter((b) => b.id !== selectedId));
    setSelectedId(null);
    setDirty(true);
  }, [selectedId]);

  const toggleLock = useCallback(() => {
    if (!selectedId) return;
    setBeacons((bs) => bs.map((b) => (b.id === selectedId ? { ...b, locked: !b.locked } : b)));
    setDirty(true);
  }, [selectedId]);

  // Delete 키로 삭제
  useEffect(() => {
    const h = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        if (document.activeElement?.tagName === 'INPUT') return;
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selectedId, deleteSelected]);

  const floorBeacons = useMemo(
    () => beacons.filter((b) => b.floor === floor), [beacons, floor]);
  /**
   * 설치용 CSV — 현장 작업자가 그대로 들고 다니는 표.
   * 좌표만으로는 부착 지점을 잡기 어려우므로 층·모드·부착높이를 같이 싣고,
   * UUID / Major / Minor / MAC 을 빈칸으로 남겨 현장에서 채우게 한다.
   */
  const doCsv = () => {
    const o = plan.siteOrigin();
    const head = [
      'id', 'floor', 'mode', 'X_m', 'Y_m', 'Z_m',
      'mountHeight_m', 'txPower_dBm', 'role',
      'UUID', 'Major', 'Minor', 'MAC'
    ];
    const rows = beacons.map((b) => {
      const c = plan.siteXYZ(b);
      return [
        b.id, plan.floorNames[b.floor],
        modes[b.floor] === 'checkpoint' ? 'checkpoint' : 'positioning',
        c.X, c.Y, c.Z,
        b.height, b.txPowerDbm, b.role || '',
        '', '', '', ''
      ].join(',');
    });
    const meta = [
      `# ${plan.building} 비콘 설치 좌표`,
      `# 원점(0,0) = 건물 외곽 정중앙 · X 동서 / Z 남북 / Y 1F 바닥 기준 절대 높이`,
      `# 건물 크기 ${o.spanX.toFixed(1)} x ${o.spanZ.toFixed(1)} m · 비콘 ${beacons.length}개`,
      `# UUID/Major/Minor/MAC 은 현장에서 부착한 비콘 값을 적어 넣으세요`
    ];
    const csv = '\uFEFF' + meta.concat(head.join(','), rows).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `BeaconInstall_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const cur = results?.find((r) => r.floor === floor);
  const selected = beacons.find((b) => b.id === selectedId);

  if (err && !plan) return <div className="fatal">{err}</div>;
  if (!plan || !rf) return <div className="loading">불러오는 중…</div>;

  const chk = (label, obj, setObj, key, hint = '') => (
    <label className="field chk" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={!!obj[key]}
             onChange={(e) => setObj({ ...obj, [key]: e.target.checked })} />
    </label>
  );

  const num = (label, obj, setObj, key, step = 1, unit = '', hint = '') => (
    <label className="field" title={hint}>
      <span>{label}{unit && <em> ({unit})</em>}</span>
      <input type="number" step={step} value={obj[key]}
             onChange={(e) => setObj({ ...obj, [key]: parseFloat(e.target.value) || 0 })} />
    </label>
  );

  return (
    <div className="app">
      {/* ================= 좌측: 입력 ================= */}
      <aside className="panel left">
        <h1>비콘 배치 추천</h1>
        <p className="sub">{plan.building} · 아주대 Brain 캡스톤</p>

        <section>
          <h2>① 비콘 제원</h2>
          <label className="field">
            <span>모델명</span>
            <input value={rf.model} onChange={(e) => setRf({ ...rf, model: e.target.value })} />
          </label>
          {num('비콘 단가', rf, setRf, 'unitCost', 1000, '원', '이 값 × 비콘 개수 = 총 비용')}
          {num('송신 출력', rf, setRf, 'txPowerDbm', 1, 'dBm', 'Minew i3 는 -30 ~ +4 dBm')}
          {num('1m 기준세기 (Tx 0dBm)', rf, setRf, 'measuredPower1mAt0dBm', 1, 'dBm',
               '★ 실측으로 반드시 교체할 값')}
          {num('경로손실 지수 n', rf, setRf, 'pathLossExponent', 0.1, '',
               '개활 2.0~2.2 / 몰 통로 2.5 / 매장밀집 3.0+')}
          {num('측위 임계', rf, setRf, 'positioningThresholdDbm', 1, 'dBm',
               '이보다 세야 거리추정에 쓸 수 있다')}
          {num('검출 임계', rf, setRf, 'detectThresholdDbm', 1, 'dBm',
               '이보다 세면 "잡힌다"')}
          <details>
            <summary>매질 감쇠</summary>
            {num('구조벽', rf, setRf, 'structuralLossDb', 1, 'dB')}
            {num('칸막이', rf, setRf, 'partitionLossDb', 1, 'dB')}
            {num('유리', rf, setRf, 'glassLossDb', 1, 'dB')}
            {num('층간 슬래브', rf, setRf, 'slabLossDb', 1, 'dB')}
          </details>
          <p className="note">
            ⚠️ 이 숫자들은 문헌값입니다. 측위 임계를 5 dB만 바꿔도 커버리지가
            30%→95%로 뒤집힙니다. 현장 실측으로 교체하세요.
          </p>
        </section>

        <section>
          <h2>② 층별 모드</h2>
          <p className="note">
            지상은 GPS로 위치가 잡히므로 층간이동만 판별하면 됩니다 →
            승강장에만 비콘(체크포인트). 지하는 GPS가 없으므로 전면 측위.
          </p>
          {plan.floorNames.map((n, i) => (
            <div key={n} className="moderow">
              <b>{n}</b>
              <select value={modes[i]} onChange={(e) => {
                const m = [...modes]; m[i] = e.target.value; setModes(m);
              }}>
                <option value="positioning">측위 (전면 배치)</option>
                <option value="checkpoint">체크포인트 (승강장만)</option>
              </select>
            </div>
          ))}
        </section>

        <details>
          <summary><b>최적화 설정</b></summary>
          {num('평가격자', settings, setSettings, 'evalStepM', 0.5, 'm')}
          {num('후보격자', settings, setSettings, 'candidateStepM', 0.5, 'm')}
          {num('설치 높이', settings, setSettings, 'mountHeightM', 0.1, 'm')}
          {num('최소 동시가시', settings, setSettings, 'minVisible', 1, '개')}
          {num('목표 커버리지', settings, setSettings, 'targetCoverage', 0.01, '0~1')}
          {num('층당 최대 비콘', settings, setSettings, 'maxBeaconsPerFloor', 1, '개',
               '예산 상한. 여기 걸리면 목표 미달로 표시됩니다')}
          {num('최소 이격', settings, setSettings, 'minSeparationM', 0.5, 'm')}
          {chk('임대매장 내부에도 설치', settings, setSettings, 'allowInsideStores',
               '보통 공용부(통로)만 시공 가능합니다. 켜면 매장 안에도 놓아 커버리지가 올라가지만 실제로는 설치 협의가 필요합니다.')}
          <p className="note">
            매장 내부를 제외하면 통로에서만 신호를 쏘게 되어 3중 커버리지가
            떨어집니다(B1 기준 95% → 82%). 어느 쪽이 현실적인지는 시공 조건에 달렸습니다.
          </p>
        </details>

        <div className="actions">
          <button className="primary" onClick={doPlan} disabled={!!busy}>③ 배치 계산</button>
          <button onClick={doEvaluate} disabled={!!busy || beacons.length === 0}>
            현재 배치 재평가
          </button>
        </div>
        {busy && <p className="busy">{busy}</p>}
        {err && <p className="err">{err}</p>}
      </aside>

      {/* ================= 중앙: 도면 ================= */}
      <main className="center">
        <div className="toolbar">
          <div className="floors">
            {plan.floorNames.map((n, i) => (
              <button key={n} className={i === floor ? 'on' : ''} onClick={() => setFloor(i)}>
                {n}
                <em>{modes[i] === 'checkpoint' ? 'CP' : 'POS'}</em>
              </button>
            ))}
          </div>
          <div className="toggles">
            <label><input type="checkbox" checked={showStores}
                          onChange={(e) => setShowStores(e.target.checked)} /> 매장</label>
            <label><input type="checkbox" checked={showLabels}
                          onChange={(e) => setShowLabels(e.target.checked)} /> ID</label>
            <label><input type="checkbox" checked={showRange}
                          onChange={(e) => setShowRange(e.target.checked)} /> 도달범위</label>
          </div>
        </div>

        <FloorCanvas
          floorData={plan.floors[floor]}
          floor={floor}
          beacons={floorBeacons}
          cores={plan.cores}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={moveBeacon}
          onAdd={addBeacon}
          showStores={showStores}
          showLabels={showLabels}
          radiusM={showRange ? 8 : 0}
        />

        <div className="hint">
          <b>④ 커스터마이징</b> — 비콘을 <b>드래그</b>하면 이동,
          빈 곳에서 <b>Shift+클릭</b>하면 추가, 선택 후 <b>Delete</b>로 삭제.
          {selected && (
            <span className="selinfo">
              선택: <b>{selected.id}</b>
              {' '}설치좌표 X {plan.siteXYZ(selected).X} · Y {plan.siteXYZ(selected).Y} · Z {plan.siteXYZ(selected).Z} m
              {selected.coreType && ` · ${selected.coreType}`}
              <button onClick={toggleLock}>{selected.locked ? '고정 해제' : '고정'}</button>
              <button onClick={deleteSelected}>삭제</button>
            </span>
          )}
        </div>
      </main>

      {/* ================= 우측: 결과 ================= */}
      <aside className="panel right">
        <section>
          <h2>비용</h2>
          {cost ? (
            <>
              <table className="tbl">
                <thead><tr><th>층</th><th>모드</th><th>개수</th><th>비용</th></tr></thead>
                <tbody>
                  {cost.byFloor.map((f) => (
                    <tr key={f.floor} className={f.floor === floor ? 'hi' : ''}>
                      <td>{f.floorName}</td>
                      <td>{f.mode === 'positioning' ? '측위' : '체크포인트'}</td>
                      <td className="n">{f.count}</td>
                      <td className="n">{won(f.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan="2">지하 측위</td>
                      <td className="n">{cost.positioningCount}</td>
                      <td className="n">{won(cost.positioningCost)}</td></tr>
                  <tr><td colSpan="2">지상 체크포인트</td>
                      <td className="n">{cost.checkpointCount}</td>
                      <td className="n">{won(cost.checkpointCost)}</td></tr>
                  <tr className="total"><td colSpan="2">합계</td>
                      <td className="n">{cost.totalCount}</td>
                      <td className="n">{won(cost.totalCost)}</td></tr>
                </tfoot>
              </table>
              <p className="note">비콘 단가 {won(cost.unitCost)} 기준</p>
            </>
          ) : <p className="note">배치를 계산하면 비용이 나옵니다.</p>}
        </section>

        <section>
          <h2>{plan.floorNames[floor]} 결과</h2>
          {dirty && <p className="warn">배치를 수정했습니다 — [현재 배치 재평가]를 눌러야 지표가 갱신됩니다.</p>}
          {cur ? (
            cur.mode === 'checkpoint' ? (
              <ul className="kv">
                <li><span>체크포인트</span><b>{cur.beacons.length}개 / 수직동선 {cur.coreCount}곳</b></li>
                <li><span>평균 포착반경</span><b>{cur.meanCaptureRadiusM} m</b></li>
                <li><span>검출 가능 면적</span><b>{pct(cur.coverage1)}</b></li>
                {cur.offPlanCores?.length > 0 && (
                  <li className="bad"><span>도면 확인 필요</span><b>{cur.offPlanCores.length}곳</b></li>
                )}
              </ul>
            ) : (
              <ul className="kv">
                <li><span>비콘</span><b>{cur.beacons.length}개</b></li>
                <li><span>보행면적</span><b>{cur.walkableAreaM2.toFixed(0)} ㎡
                  ({(cur.walkableAreaM2 / Math.max(1, cur.beacons.length)).toFixed(0)} ㎡/개)</b></li>
                <li><span>1중 커버리지</span><b>{pct(cur.coverage1)}</b></li>
                <li><span>3중 커버리지</span><b>{pct(cur.coverage3)}</b></li>
                <li><span>HDOP ≤ {settings.maxHdop}</span><b>{pct(cur.goodHdopRatio)}</b></li>
                <li><span>평균 HDOP</span><b>{cur.meanHdop.toFixed(2)}</b></li>
                {cur.budgetBound && <li className="bad"><span>예산 상한</span><b>목표 미달</b></li>}
              </ul>
            )
          ) : <p className="note">아직 계산 전입니다.</p>}
        </section>

        {discrim && (
          <section>
            <h2>층 판별 정확도</h2>
            <p className="note">
              지상에서 아래층 비콘이 더 세게 잡히면 층을 오판합니다.
              <b>성공률</b>은 전체 보행지점 중 층을 맞게 판별한 비율이고,
              <b>신호</b>는 그중 신호가 잡힌 지점의 비율입니다.
              비콘을 지우면 신호가 안 잡히는 지점이 늘어 성공률이 바로 내려갑니다.
            </p>
            <table className="tbl">
              <thead><tr><th>층</th><th>성공률</th><th>신호</th><th>오판</th><th>무신호</th></tr></thead>
              <tbody>
                {discrim.perFloor.map((d) => (
                  <tr key={d.floor} className={d.floor === floor ? 'hi' : ''}>
                    <td>{d.floorName}</td>
                    <td className={'n' + (d.successRate < 0.9 ? ' bad' : '')}>{pct(d.successRate)}</td>
                    <td className="n">{pct(d.signalRatio)}</td>
                    <td className="n">{d.wrong}</td>
                    <td className="n">{d.silent}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total"><td>전체</td>
                    <td className="n">{pct(discrim.overallSuccess)}</td>
                    <td className="n">{pct(discrim.signalRatio)}</td>
                    <td className="n">{discrim.totalWrong}</td>
                    <td className="n">{discrim.totalSilent}</td></tr>
              </tfoot>
            </table>
            <p className="note">
              신호 잡힌 지점만 놓고 본 정확도는 {pct(discrim.overallAccuracy)} 입니다
              (오판 {discrim.totalWrong} / 무신호 {discrim.totalSilent} / 전체 {discrim.totalPoints}).
            </p>
          </section>
        )}

        <section>
          <h2>설치 좌표</h2>
          <p className="note">
            원점 (0, 0) 은 <b>건물 외곽의 정중앙</b>입니다.
            X 는 동서, Z 는 남북, Y 는 1층 바닥을 0 으로 한 절대 높이입니다.
            현장에서는 이 표를 그대로 들고 가면 됩니다.
          </p>
          <table className="tbl">
            <thead><tr><th>ID</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
            <tbody>
              {floorBeacons.map((b) => {
                const c = plan.siteXYZ(b);
                return (
                  <tr key={b.id} className={b.id === selectedId ? 'hi' : ''}
                      onClick={() => setSelectedId(b.id)}>
                    <td>{b.id}</td>
                    <td className="n">{c.X}</td>
                    <td className="n">{c.Y}</td>
                    <td className="n">{c.Z}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="note">
            {plan.floorNames[floor]} {floorBeacons.length}개 ·
            건물 크기 {plan.siteOrigin().spanX.toFixed(1)} × {plan.siteOrigin().spanZ.toFixed(1)} m
          </p>
        </section>

        <section>
          <h2>⑤ 저장</h2>
          <div className="actions">
            <button className="primary" onClick={doSave} disabled={beacons.length === 0}>
              JSON 저장
            </button>
            <button onClick={doCsv} disabled={beacons.length === 0}>
              설치용 CSV
            </button>
            <label className="filebtn">
              불러오기
              <input type="file" accept="application/json"
                     onChange={(e) => e.target.files[0] && doLoad(e.target.files[0])} />
            </label>
          </div>
          <p className="note">
            JSON 은 제원·설정·지표까지 통째로 저장합니다.<br />
            <b>설치용 CSV</b> 는 전 층 비콘의 XYZ 좌표에 UUID / Major / Minor / MAC 빈칸을
            붙여 내보냅니다 — 현장에서 부착한 비콘의 식별자를 그 자리에 적어 넣으면
            그대로 매핑표가 됩니다.
          </p>
        </section>
      </aside>
    </div>
  );
}
