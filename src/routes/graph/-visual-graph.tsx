import { useEffect, useRef, useState } from 'react';

export type VisualKind = 'domain' | 'node' | 'course';

export interface VisualItem {
  id: string;
  label: string;
  kind: VisualKind;
  color: string;
  status?: string;
}

export interface VisualLink {
  source: string;
  target: string;
  kind: 'domain' | 'rel' | 'course';
}

interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
}

const W = 960;
const H = 560;

/**
 * 轻量 SVG 力导向图（无 D3 依赖，自含小规模力模拟）。
 * 节点：领域（大）／知识节点（中）／课程（小）；边：领域—节点／节点关系／
 * 节点—课程。支持拖节点、滚轮缩放、拖背景平移、点节点选中。
 */
export function VisualGraph({
  items,
  links,
  selectedId,
  onSelect,
}: {
  items: VisualItem[];
  links: VisualLink[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const posRef = useRef(new Map<string, Pos>());
  const [, setTick] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const dragRef = useRef<{
    id: string | null;
    px: number;
    py: number;
    moved: boolean;
  }>({ id: null, px: 0, py: 0, moved: false });
  const panRef = useRef<{
    px: number;
    py: number;
    vx: number;
    vy: number;
  } | null>(null);

  // 初始化位置：领域排成圆环，节点/课程落在所属领域附近。
  useEffect(() => {
    const pos = new Map<string, Pos>();
    const domains = items.filter((i) => i.kind === 'domain');
    const domainAngle = new Map<string, number>();
    domains.forEach((d, i) => {
      const a = (i / Math.max(domains.length, 1)) * Math.PI * 2;
      domainAngle.set(d.id, a);
      pos.set(d.id, {
        x: W / 2 + Math.cos(a) * 220,
        y: H / 2 + Math.sin(a) * 170,
        vx: 0,
        vy: 0,
      });
    });
    // 节点归属：找一条连到它的领域边（domain 优先），否则随机。
    const domainOf = new Map<string, string>();
    for (const l of links) {
      if (l.kind === 'domain') domainOf.set(l.target, l.source);
    }
    items.forEach((it) => {
      if (pos.has(it.id)) return;
      const dId = domainOf.get(it.id);
      const a = domainAngle.get(dId ?? '') ?? Math.random() * Math.PI * 2;
      const r = it.kind === 'course' ? 150 : 110;
      pos.set(it.id, {
        x: W / 2 + Math.cos(a) * r + (Math.random() - 0.5) * 60,
        y: H / 2 + Math.sin(a) * r * 0.75 + (Math.random() - 0.5) * 60,
        vx: 0,
        vy: 0,
      });
    });
    posRef.current = pos;
    setTick((t) => t + 1);
  }, [items, links]);

  // 力模拟：斥力＋弹簧＋向心，冷却后停。
  useEffect(() => {
    let raf = 0;
    let alpha = 1;
    const byId = new Map(items.map((i) => [i.id, i]));
    const step = () => {
      const pos = posRef.current;
      const arr = [...pos.entries()];
      // 斥力（截断距离内才算，O(n²) 但节点数 ~150 以内可接受）。
      for (let i = 0; i < arr.length; i++) {
        const [idA, a] = arr[i];
        if (a.fx !== undefined) continue;
        for (let j = i + 1; j < arr.length; j++) {
          const [idB, b] = arr[j];
          if (b.fx !== undefined) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 90 * 90 || d2 < 0.01) continue;
          const d = Math.sqrt(d2);
          const f = (2600 / d2) * alpha;
          dx /= d;
          dy /= d;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
          void idA;
          void idB;
        }
      }
      // 弹簧。
      for (const l of links) {
        const a = pos.get(l.source);
        const b = pos.get(l.target);
        if (!a || !b) continue;
        const rest = l.kind === 'course' ? 55 : l.kind === 'domain' ? 110 : 90;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = ((d - rest) / d) * 0.06 * alpha;
        dx *= f;
        dy *= f;
        if (a.fx === undefined) {
          a.vx += dx;
          a.vy += dy;
        }
        if (b.fx === undefined) {
          b.vx -= dx;
          b.vy -= dy;
        }
      }
      // 向心＋阻尼＋积分。
      for (const [, p] of arr) {
        if (p.fx !== undefined) {
          p.x = p.fx;
          p.y = p.fy ?? p.y;
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx += (W / 2 - p.x) * 0.004 * alpha;
        p.vy += (H / 2 - p.y) * 0.004 * alpha;
        p.vx *= 0.86;
        p.vy *= 0.86;
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const cap = 12;
        if (sp > cap) {
          p.vx = (p.vx / sp) * cap;
          p.vy = (p.vy / sp) * cap;
        }
        p.x += p.vx;
        p.y += p.vy;
        p.x = Math.max(20, Math.min(W - 20, p.x));
        p.y = Math.max(20, Math.min(H - 20, p.y));
      }
      void byId;
      alpha *= 0.985;
      setTick((t) => t + 1);
      if (alpha > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [items, links]);

  const toSvg = (e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const onPointerDownNode = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const p = toSvg(e);
    dragRef.current = { id, px: p.x, py: p.y, moved: false };
    const pos = posRef.current.get(id);
    if (pos) {
      pos.fx = pos.x;
      pos.fy = pos.y;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toSvg(e);
    const drag = dragRef.current;
    if (drag.id) {
      const pos = posRef.current.get(drag.id);
      if (pos) {
        const dx = p.x - drag.px;
        const dy = p.y - drag.py;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        // toSvg 给的是 viewBox 坐标，要换算进 transform 后的世界坐标。
        pos.fx = (p.x - view.x) / view.k;
        pos.fy = (p.y - view.y) / view.k;
      }
      setTick((t) => t + 1);
      return;
    }
    if (panRef.current) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = ((e.clientX - panRef.current.px) / rect.width) * W;
      const dy = ((e.clientY - panRef.current.py) / rect.height) * H;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      panRef.current.px = e.clientX;
      panRef.current.py = e.clientY;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag.id) {
      const pos = posRef.current.get(drag.id);
      if (pos) {
        pos.fx = undefined;
        pos.fy = undefined;
      }
      if (!drag.moved) onSelect(drag.id);
      dragRef.current = { id: null, px: 0, py: 0, moved: false };
    }
    panRef.current = null;
    void e;
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => ({
      ...v,
      k: Math.max(0.4, Math.min(3, v.k * factor)),
    }));
  };

  const radius = (kind: VisualKind) =>
    kind === 'domain' ? 13 : kind === 'node' ? 8 : 5;
  const pos = posRef.current;
  const labelFor = (it: VisualItem) => {
    if (it.kind === 'domain') return true;
    if (it.id === selectedId || it.id === hoverId) return true;
    return view.k >= 1.6;
  };

  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[560px] w-full touch-none select-none"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
        onPointerDown={(e) => {
          const p = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
          panRef.current = p;
        }}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {links.map((l, i) => {
            const a = pos.get(l.source);
            const b = pos.get(l.target);
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--border)"
                strokeWidth={l.kind === 'domain' ? 1.4 : 0.8}
                strokeDasharray={l.kind === 'rel' ? '3 3' : undefined}
                opacity={0.7}
              />
            );
          })}
          {items.map((it) => {
            const p = pos.get(it.id);
            if (!p) return null;
            const r = radius(it.kind);
            const selected = it.id === selectedId;
            const hovered = it.id === hoverId;
            return (
              <g
                key={it.id}
                transform={`translate(${p.x} ${p.y})`}
                onPointerDown={(e) => onPointerDownNode(e, it.id)}
                onPointerEnter={() => setHoverId(it.id)}
                onPointerLeave={() => setHoverId(null)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  r={selected || hovered ? r + 3 : r}
                  fill={it.color}
                  fillOpacity={it.kind === 'course' ? 0.75 : 0.95}
                  stroke={selected ? 'var(--primary)' : 'var(--background)'}
                  strokeWidth={selected ? 2.5 : 1}
                />
                {labelFor(it) && (
                  <text
                    y={r + 13}
                    textAnchor="middle"
                    fontSize={it.kind === 'domain' ? 12 : 10}
                    fontWeight={it.kind === 'domain' ? 600 : 400}
                    fill="var(--foreground)"
                    pointerEvents="none"
                  >
                    {it.label.length > 14
                      ? `${it.label.slice(0, 14)}…`
                      : it.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-full bg-[#2563eb]" />
          领域
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-full bg-[#059669]" />
          知识节点
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-full bg-[#d97706]" />
          课程
        </span>
        <span className="ml-auto">
          拖节点移动 · 拖空白平移 · 滚轮缩放 · 点节点看详情
        </span>
      </div>
    </div>
  );
}
