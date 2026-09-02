// ---------------------------------------------------------------------------
//  FloorCanvas.jsx
//  도면 + 비콘을 SVG 로 그리고, 클릭으로 추가 / 드래그로 이동 / 선택 후 삭제.
//
//  좌표계: 도면은 유니티 월드 미터(x, z). SVG 는 y 가 아래로 자라므로
//  z 축을 뒤집어서 그린다 (transform scale(1,-1) 대신 viewBox 로 처리).
// ---------------------------------------------------------------------------
import React, { useMemo, useRef, useState, useCallback } from 'react';

const COLORS = {
  slab: '#f7f7f9',
  slabEdge: '#3c4257',
  boh: '#dfe3ea',
  bohEdge: '#aab2c0',
  atrium: '#ffffff',
  store: '#eef3fb',
  storeEdge: '#b9cbe6',
  grid: '#2f7ed8',
  core: '#e8710a',
  checkpoint: '#c8442f',
  locked: '#1a7f37',
  selected: '#111827'
};

const CORE_ICON = { Elevator: 'EV', Stair: 'ST', Escalator: 'ES' };

export default function FloorCanvas({
  floorData, floor, beacons, cores, selectedId,
  onSelect, onMove, onAdd, showStores, showLabels, radiusM
}) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  // mousedown 이 비콘에서 시작했는지. click 은 mouseup 뒤에 오는데
  // 그때는 이미 drag 가 풀려 있어서 배경 클릭과 구분이 안 된다.
  const downOnBeacon = useRef(false);

  // ---- 뷰박스: 슬래브 경계 + 여백 ----
  const view = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of floorData.slab) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const pad = 6;
    return {
      minX: minX - pad, minZ: minZ - pad,
      w: maxX - minX + pad * 2, h: maxZ - minZ + pad * 2
    };
  }, [floorData]);

  // SVG 는 y 아래로 증가 → z 를 뒤집는다
  const toSvg = useCallback((x, z) => [x, view.minZ + view.h - (z - view.minZ)], [view]);
  const fromSvg = useCallback((sx, sy) => [sx, view.minZ + view.h - (sy - view.minZ)], [view]);

  const pathOf = (poly) =>
    poly.map((p, i) => {
      const [sx, sy] = toSvg(p[0], p[1]);
      return `${i === 0 ? 'M' : 'L'}${sx.toFixed(2)},${sy.toFixed(2)}`;
    }).join(' ') + ' Z';

  // ---- 마우스 좌표를 도면 미터로 ----
  const eventToWorld = (e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return fromSvg(p.x, p.y);
  };

  const handleDown = (e, b) => {
    e.stopPropagation();
    downOnBeacon.current = true;
    onSelect(b.id);
    const [wx, wz] = eventToWorld(e);
    setDrag({ id: b.id, dx: b.x - wx, dz: b.z - wz, moved: false });
  };

  const handleMove = (e) => {
    if (!drag) return;
    const [wx, wz] = eventToWorld(e);
    onMove(drag.id, +(wx + drag.dx).toFixed(2), +(wz + drag.dz).toFixed(2));
    if (!drag.moved) setDrag({ ...drag, moved: true });
  };

  const handleUp = () => setDrag(null);

  const handleBgClick = (e) => {
    // 비콘에서 시작한 클릭(선택 또는 드래그)은 배경 클릭이 아니다
    if (downOnBeacon.current) { downOnBeacon.current = false; return; }
    if (drag) return;
    if (e.shiftKey) {
      const [wx, wz] = eventToWorld(e);
      onAdd(+wx.toFixed(2), +wz.toFixed(2));
    } else {
      onSelect(null);
    }
  };

  const floorCores = cores.filter((c) => floor >= c.floorLo && floor <= c.floorHi);

  return (
    <svg
      ref={svgRef}
      className="floorcanvas"
      viewBox={`${view.minX} ${view.minZ} ${view.w} ${view.h}`}
      onMouseDownCapture={() => { downOnBeacon.current = false; }}
      onMouseMove={handleMove}
      onMouseUp={handleUp}
      onMouseLeave={handleUp}
      onClick={handleBgClick}
    >
      {/* 슬래브 */}
      <path d={pathOf(floorData.slab)} fill={COLORS.slab} stroke={COLORS.slabEdge} strokeWidth="0.8" />

      {/* BOH (비보행 영역) */}
      {floorData.boh.map((p, i) => (
        <path key={`boh${i}`} d={pathOf(p)} fill={COLORS.boh} stroke={COLORS.bohEdge} strokeWidth="0.4" />
      ))}

      {/* 아트리움 개방부 */}
      {floorData.atrium.map((p, i) => (
        <path key={`at${i}`} d={pathOf(p)} fill={COLORS.atrium} stroke={COLORS.bohEdge}
              strokeWidth="0.4" strokeDasharray="1.5 1.5" />
      ))}

      {/* 매장 */}
      {showStores && floorData.stores.map((s, i) => (
        <path key={`st${i}`} d={pathOf(s.pts)} fill={COLORS.store}
              stroke={COLORS.storeEdge} strokeWidth="0.3" />
      ))}

      {/* 수직동선 축 */}
      {floorCores.map((c, i) => {
        const [ax, ay] = toSvg(c.ax, c.az);
        const [bx, by] = toSvg(c.bx, c.bz);
        return (
          <g key={`core${i}`}>
            <line x1={ax} y1={ay} x2={bx} y2={by}
                  stroke={COLORS.core} strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
            <text x={(ax + bx) / 2} y={(ay + by) / 2 - 1.4} fontSize="2.4"
                  textAnchor="middle" fill={COLORS.core} opacity="0.9">
              {CORE_ICON[c.type] || c.type}
            </text>
          </g>
        );
      })}

      {/* 비콘 도달범위 */}
      {radiusM > 0 && beacons.map((b) => {
        const [cx, cy] = toSvg(b.x, b.z);
        return <circle key={`r${b.id}`} cx={cx} cy={cy} r={radiusM}
                       fill={b.role === 'checkpoint' ? COLORS.checkpoint : COLORS.grid}
                       opacity="0.07" pointerEvents="none" />;
      })}

      {/* 비콘 */}
      {beacons.map((b) => {
        const [cx, cy] = toSvg(b.x, b.z);
        const sel = b.id === selectedId;
        const color = b.locked ? COLORS.locked
                    : b.role === 'checkpoint' ? COLORS.checkpoint
                    : b.role === 'core' ? COLORS.core : COLORS.grid;
        return (
          <g key={b.id}
             onMouseDown={(e) => handleDown(e, b)}
             onClick={(e) => e.stopPropagation()}
             style={{ cursor: 'grab' }}>
            <circle cx={cx} cy={cy} r={sel ? 2.6 : 1.7}
                    fill={color} stroke={sel ? COLORS.selected : '#fff'}
                    strokeWidth={sel ? 1.0 : 0.5} />
            {b.offPlan && (
              <circle cx={cx} cy={cy} r="4" fill="none" stroke="#d93025"
                      strokeWidth="0.6" strokeDasharray="1 1" />
            )}
            {showLabels && (
              <text x={cx} y={cy - 3.2} fontSize="2.2" textAnchor="middle" fill="#1f2937">
                {b.id}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
