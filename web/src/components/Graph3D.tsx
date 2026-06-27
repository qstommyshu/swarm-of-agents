"use client";

import * as React from "react";
import {
  EDGE_KIND_META,
  NODE_KIND_META,
  type GraphData,
  type GraphLink,
  type GraphNode,
} from "@/lib/data";

export interface Graph3DHandle {
  focusNode: (id: string) => void;
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

interface Graph3DProps {
  data: GraphData;
  selectedNodeId: string | null;
  selectedLinkId: string | null;
  onSelectNode: (id: string) => void;
  onSelectLink: (id: string) => void;
  onDoubleClickNode?: (id: string) => void;
  criticalPathMode?: boolean;
  criticalPathNodeIds?: Set<string>;
  criticalPathLinkIds?: Set<string>;
}

type Point = { x: number; y: number };

const CANVAS = { width: 1500, height: 1840 };
const NODE = { width: 188, height: 62 };

const DEFAULT_POSITIONS: Record<string, Point> = {
  "api-gateway": { x: 656, y: 150 },
  "auth-layer": { x: 390, y: 320 },
  idp: { x: 125, y: 320 },
  "orders-module": { x: 656, y: 430 },
  rabbitmq: { x: 656, y: 635 },
  "payments-service": { x: 656, y: 860 },
  redis: { x: 390, y: 860 },
  "env-config": { x: 955, y: 860 },
  "ledger-service": { x: 390, y: 1110 },
  "rbc-rail-adapter": { x: 656, y: 1110 },
  stripe: { x: 955, y: 1110 },
  plaid: { x: 125, y: 1110 },
  postgres: { x: 390, y: 1360 },
  kafka: { x: 955, y: 1360 },
  "notification-service": { x: 955, y: 1570 },
  sendgrid: { x: 1220, y: 1570 },
};

// The primary money-path through the system
const ENTRY_NODE_ID = "api-gateway";

const FLOW_RAILS = [
  { y: 120,  label: "Ingress" },
  { y: 390,  label: "Validation" },
  { y: 610,  label: "Queue" },
  { y: 835,  label: "Core processing" },
  { y: 1085, label: "Rails + ledger" },
  { y: 1340, label: "Storage + events" },
  { y: 1550, label: "Notifications" },
];

function fallbackPosition(index: number): Point {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { x: 140 + col * 300, y: 170 + row * 180 };
}

function centerOf(node: GraphNode, index: number): Point {
  const p = DEFAULT_POSITIONS[node.id] ?? fallbackPosition(index);
  return { x: p.x + NODE.width / 2, y: p.y + NODE.height / 2 };
}

function linkPath(source: Point, target: Point): string {
  const dy = Math.max(95, Math.abs(target.y - source.y) * 0.48);
  const c1 = { x: source.x, y: source.y + dy };
  const c2 = { x: target.x, y: target.y - dy };
  return `M ${source.x} ${source.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${target.x} ${target.y}`;
}

function relationshipLabel(link: GraphLink): string {
  const packageMatch = link.contract.match(/^Package:\s*(.+)$/m);
  if (packageMatch?.[1]) return `uses ${packageMatch[1]}`;
  const typeMatch = link.contract.match(/^Relationship type:\s*(.+)$/m);
  return typeMatch?.[1] ?? EDGE_KIND_META[link.kind].label;
}

export const Graph3D = React.forwardRef<Graph3DHandle, Graph3DProps>(
  function Graph3D(
    {
      data,
      selectedNodeId,
      selectedLinkId,
      onSelectNode,
      onSelectLink,
      onDoubleClickNode,
      criticalPathMode = false,
      criticalPathNodeIds,
      criticalPathLinkIds,
    },
    ref,
  ) {
    const [size, setSize] = React.useState({ w: 0, h: 0 });
    const [view, setView] = React.useState({ x: 0, y: 0, scale: 0.72 });
    const [drag, setDrag] = React.useState<{
      startX: number;
      startY: number;
      baseX: number;
      baseY: number;
    } | null>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        const r = entries[0].contentRect;
        setSize({ w: r.width, h: r.height });
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    const nodeIndex = React.useMemo(() => {
      const map = new Map<string, { node: GraphNode; index: number }>();
      data.nodes.forEach((node, index) => map.set(node.id, { node, index }));
      return map;
    }, [data.nodes]);

    // Highlighted sets — driven by selection or critical path mode
    const { hlNodes, hlLinks } = React.useMemo(() => {
      if (criticalPathMode && criticalPathNodeIds && criticalPathLinkIds) {
        return { hlNodes: criticalPathNodeIds, hlLinks: criticalPathLinkIds };
      }
      const nodes = new Set<string>();
      const links = new Set<string>();
      if (selectedLinkId) {
        const l = data.links.find((x) => x.id === selectedLinkId);
        if (l) {
          links.add(l.id);
          nodes.add(l.source);
          nodes.add(l.target);
        }
      } else if (selectedNodeId) {
        nodes.add(selectedNodeId);
        for (const l of data.links) {
          if (l.source === selectedNodeId || l.target === selectedNodeId) {
            links.add(l.id);
            nodes.add(l.source);
            nodes.add(l.target);
          }
        }
      }
      return { hlNodes: nodes, hlLinks: links };
    }, [data, selectedNodeId, selectedLinkId, criticalPathMode, criticalPathNodeIds, criticalPathLinkIds]);

    const hasSelection = hlNodes.size > 0 || criticalPathMode;
    const showEntryPulse = !hasSelection;
    const minScale = size.w > 0 && size.w < 640 ? 0.22 : 0.64;

    const focusNode = React.useCallback((id: string) => {
      const item = nodeIndex.get(id);
      if (!item || size.w === 0 || size.h === 0) return;
      const center = centerOf(item.node, item.index);
      setView((current) => ({
        ...current,
        x: size.w / 2 - center.x * current.scale,
        y: size.h / 2 - center.y * current.scale,
      }));
    }, [nodeIndex, size.h, size.w]);

    React.useImperativeHandle(ref, () => ({
      focusNode,
      zoomIn: () => {
        if (size.w === 0 || size.h === 0) return;
        const nextScale = Math.min(1.45, view.scale * 1.16);
        setView({
          scale: nextScale,
          x: size.w / 2 - ((size.w / 2 - view.x) / view.scale) * nextScale,
          y: size.h / 2 - ((size.h / 2 - view.y) / view.scale) * nextScale,
        });
      },
      zoomOut: () => {
        if (size.w === 0 || size.h === 0) return;
        const nextScale = Math.max(minScale, view.scale / 1.16);
        setView({
          scale: nextScale,
          x: size.w / 2 - ((size.w / 2 - view.x) / view.scale) * nextScale,
          y: size.h / 2 - ((size.h / 2 - view.y) / view.scale) * nextScale,
        });
      },
      resetView: () => {
        if (size.w === 0 || size.h === 0) return;
        const scale = Math.min(
          1.02,
          Math.max(minScale, (size.w / CANVAS.width) * 0.9),
        );
        setView({
          scale,
          x: (size.w - CANVAS.width * scale) / 2,
          y: 118,
        });
      },
    }));

    React.useEffect(() => {
      if (size.w === 0 || size.h === 0) return;
      const scale = Math.min(
        1.02,
        Math.max(minScale, (size.w / CANVAS.width) * 0.9),
      );
      setView({
        scale,
        x: (size.w - CANVAS.width * scale) / 2,
        y: 118,
      });
    }, [minScale, size.h, size.w]);

    function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
      event.preventDefault();
      const nextScale = Math.min(1.45, Math.max(minScale, view.scale - event.deltaY * 0.0008));
      const rect = event.currentTarget.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const graphX = (mx - view.x) / view.scale;
      const graphY = (my - view.y) / view.scale;
      setView({
        scale: nextScale,
        x: mx - graphX * nextScale,
        y: my - graphY * nextScale,
      });
    }

    function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
      if ((event.target as HTMLElement).closest("[data-graph-control]")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({
        startX: event.clientX,
        startY: event.clientY,
        baseX: view.x,
        baseY: view.y,
      });
    }

    function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
      if (!drag) return;
      setView((current) => ({
        ...current,
        x: drag.baseX + event.clientX - drag.startX,
        y: drag.baseY + event.clientY - drag.startY,
      }));
    }

    function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
      if (drag) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDrag(null);
    }

    const visibleLinks = data.links
      .map((link) => {
        const sourceItem = nodeIndex.get(link.source);
        const targetItem = nodeIndex.get(link.target);
        if (!sourceItem || !targetItem) return null;
        return {
          link,
          source: centerOf(sourceItem.node, sourceItem.index),
          target: centerOf(targetItem.node, targetItem.index),
        };
      })
      .filter(Boolean) as Array<{ link: GraphLink; source: Point; target: Point }>;

    // Entry node pulse ring dimensions
    const entryPos = DEFAULT_POSITIONS[ENTRY_NODE_ID];
    const entryCX = entryPos ? entryPos.x + NODE.width / 2 : 0;
    const entryCY = entryPos ? entryPos.y + NODE.height / 2 : 0;

    return (
      <div
        ref={containerRef}
        className="relative h-full w-full cursor-grab overflow-hidden bg-[#0c0d10] active:cursor-grabbing"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={() => onSelectNode("")}
      >
        {/* Dot grid background */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(129,140,248,0.12)_1px,transparent_1px)] bg-[length:72px_72px] opacity-[0.08]" />

        <div
          className="absolute left-0 top-0 origin-top-left transition-transform duration-150"
          style={{
            width: CANVAS.width,
            height: CANVAS.height,
            transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
          }}
        >
          <svg
            className="absolute inset-0 overflow-visible"
            width={CANVAS.width}
            height={CANVAS.height}
            viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
            aria-hidden="true"
          >
            <defs>
              <filter id="dependencyGlow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="5" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="entryGlow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="8" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <marker
                id="arrow"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#5c5e6a" />
              </marker>
              <marker
                id="arrow-critical"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#f87171" />
              </marker>
            </defs>

            {/* ── Flow rail labels ── */}
            {FLOW_RAILS.map((rail) => (
              <g key={rail.label}>
                <line
                  x1={80} y1={rail.y} x2={1400} y2={rail.y}
                  stroke="#1e2028" strokeWidth={1}
                />
                <rect
                  x={80} y={rail.y - 20}
                  width={rail.label.length * 7.4 + 12} height={15}
                  fill="#0c0d10" rx={2}
                />
                <text
                  x={86} y={rail.y - 9}
                  fill="#3a3c48"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                  letterSpacing="0.08em"
                >
                  {rail.label.toUpperCase()}
                </text>
              </g>
            ))}

            {/* ── Entry-point pulse ring (shown when nothing selected) ── */}
            {showEntryPulse && entryPos && (
              <g filter="url(#entryGlow)">
                <circle
                  cx={entryCX}
                  cy={entryCY}
                  r={72}
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth={1.5}
                  opacity={0}
                >
                  <animate attributeName="r" values="72;104;72" dur="3s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.5;0;0.5" dur="3s" repeatCount="indefinite" />
                </circle>
                <circle
                  cx={entryCX}
                  cy={entryCY}
                  r={76}
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth={0.8}
                  opacity={0}
                >
                  <animate attributeName="r" values="76;116;76" dur="3s" begin="0.4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.3;0;0.3" dur="3s" begin="0.4s" repeatCount="indefinite" />
                </circle>
                {/* "start here" label below api-gateway */}
                <text
                  x={entryCX}
                  y={entryPos.y + NODE.height + 18}
                  textAnchor="middle"
                  fill="#818cf8"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                  letterSpacing="0.1em"
                  opacity={0.7}
                >
                  ↑ start here
                </text>
              </g>
            )}

            {/* ── Edges ── */}
            {visibleLinks.map(({ link, source, target }) => {
              const meta = EDGE_KIND_META[link.kind];
              const active = hlLinks.has(link.id);
              const dim = hasSelection && !active;
              const isCritical = criticalPathMode && active;
              const path = linkPath(source, target);
              const width = active ? 2.2 + link.criticality * 0.18 : 1.1;
              const glowOpacity = active ? 0.58 : hasSelection ? 0 : 0.12;
              const strokeColor = dim ? "#222" : isCritical ? "#f87171" : meta.color;
              const label = relationshipLabel(link);
              const showLabel = active || (!hasSelection && data.links.length <= 12);
              const labelX = (source.x + target.x) / 2;
              const labelY = (source.y + target.y) / 2 - 18;
              const labelWidth = Math.min(190, Math.max(72, label.length * 6.2 + 18));
              return (
                <g key={link.id} data-graph-control="true">
                  <path
                    d={path}
                    fill="none"
                    stroke={isCritical ? "#f87171" : meta.color}
                    strokeWidth={active ? 14 : 9}
                    strokeOpacity={glowOpacity}
                    strokeLinecap="round"
                    filter="url(#dependencyGlow)"
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={isCritical ? width + 0.6 : width}
                    strokeOpacity={dim ? 0.18 : active ? 0.95 : 0.42}
                    strokeDasharray={meta.dashed ? "8 7" : undefined}
                    strokeLinecap="round"
                    markerEnd={active ? (isCritical ? "url(#arrow-critical)" : "url(#arrow)") : undefined}
                    className="cursor-pointer transition-opacity duration-150"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectLink(link.id);
                    }}
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={18}
                    data-testid="graph-edge"
                    data-edge-id={link.id}
                    className="cursor-pointer"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectLink(link.id);
                    }}
                  />
                  {showLabel && !dim && (
                    <g
                      className="cursor-pointer"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectLink(link.id);
                      }}
                    >
                      <rect
                        x={labelX - labelWidth / 2}
                        y={labelY - 10}
                        width={labelWidth}
                        height={21}
                        rx={6}
                        fill="#0c0d10"
                        stroke="#2a2c36"
                        strokeWidth={1}
                        opacity={0.94}
                      />
                      <text
                        x={labelX}
                        y={labelY + 4}
                        textAnchor="middle"
                        fill={active ? "#e8e9ed" : "#8b8d98"}
                        fontSize={10}
                        fontFamily="var(--font-mono)"
                      >
                        {label.length > 24 ? `${label.slice(0, 23)}...` : label}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

          {/* ── Nodes ── */}
          {data.nodes.map((node, index) => {
            const position = DEFAULT_POSITIONS[node.id] ?? fallbackPosition(index);
            const meta = NODE_KIND_META[node.kind];
            const isSelected = selectedNodeId === node.id;
            const active = isSelected || hlNodes.has(node.id);
            const dim = hasSelection && !active;
            const inbound = data.links.filter((link) => link.target === node.id).length;
            const outbound = data.links.filter((link) => link.source === node.id).length;
            const isCritical = criticalPathMode && active;
            const isEntry = node.id === ENTRY_NODE_ID;
            return (
              <button
                key={node.id}
                data-graph-control="true"
                data-testid="graph-node"
                data-node-id={node.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectNode(node.id);
                  focusNode(node.id);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onDoubleClickNode?.(node.id);
                }}
                className="absolute cursor-pointer border bg-[#12131a] px-3 py-2 text-left transition-[border-color,background-color,opacity,box-shadow] duration-150 hover:bg-[#181a22] rounded-lg"
                style={{
                  left: position.x,
                  top: position.y,
                  width: NODE.width,
                  minHeight: NODE.height,
                  borderColor: isCritical
                    ? "#f87171"
                    : active
                    ? meta.color
                    : "#2a2c36",
                  opacity: dim ? 0.22 : 1,
                  boxShadow: isCritical
                    ? "0 0 28px #f8717155"
                    : active
                    ? `0 0 24px ${meta.color}33`
                    : "none",
                }}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: isCritical ? "#f87171" : meta.color }}
                  />
                  <span className="truncate font-mono text-[12px] font-semibold text-[#e8e9ed]">
                    {node.label}
                  </span>
                  {isEntry && !hasSelection && (
                    <span className="ml-auto shrink-0 rounded border border-[#818cf8]/30 bg-[#818cf8]/10 px-1 font-mono text-[9px] text-[#818cf8]">
                      entry
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] uppercase tracking-wide text-[#5c5e6a]">
                    {meta.group}
                  </span>
                  <span className="font-mono text-[10px] text-[#5c5e6a]">
                    {inbound} in · {outbound} out
                  </span>
                </div>
                {/* Hint: double-click to explore */}
                {isSelected && (
                  <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-[#3a3c48]">
                    dbl-click to explore connections
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);
