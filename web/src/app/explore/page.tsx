"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Search, Maximize2, FileDown, X, ShieldAlert, Plus, Minus, MessageSquare,
} from "lucide-react";
import {
  NODE_KIND_META,
  EDGE_KIND_META,
  CONFIDENCE_META,
  NODE_GROUPS,
  nodeByIdIn,
  dependenciesOfIn,
  dependentsOfIn,
  type GraphData,
  type GraphNode,
  type NodeKind,
} from "@/lib/data";
import { ATLAS_WORKSPACE_ID, getScan, getScanGraph, getWorkspaceGraph } from "@/lib/api";
import { Graph3D, type Graph3DHandle } from "@/components/Graph3D";
import { ChatPanel } from "@/components/ChatPanel";
import { NodePanel } from "@/components/NodePanel";
import { LinkPanel } from "@/components/LinkPanel";
import { Logo, GithubMark, cn } from "@/components/ui";
import { NODE_ICON } from "@/components/icons";

const ALL_KINDS = Object.keys(NODE_KIND_META) as NodeKind[];
const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

const EMPTY_SET = new Set<string>();

export default function ExplorePage() {
  return (
    <React.Suspense fallback={<main className="h-screen w-screen bg-[#0c0d10]" />}>
      <ExplorePageContent />
    </React.Suspense>
  );
}

function ExplorePageContent() {
  const graphRef = React.useRef<Graph3DHandle>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const scanId = searchParams.get("scanId");
  const isSystemDetail = Boolean(scanId && searchParams.get("view") === "detail");

  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = React.useState<string | null>(null);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeKinds, setActiveKinds] = React.useState<Set<NodeKind>>(new Set(ALL_KINDS));
  const [highRiskOnly, setHighRiskOnly] = React.useState(false);
  const [graphLoad, setGraphLoad] = React.useState<{
    key: string;
    graph: GraphData | null;
    repoLabel: string;
    apiNotice: string | null;
  } | null>(null);

  // Navigation history for drill-down exploration
  const [nodeHistory, setNodeHistory] = React.useState<GraphNode[]>([]);
  const [panelView, setPanelView] = React.useState<"overview" | "subgraph">("overview");

  React.useEffect(() => {
    let cancelled = false;
    const key = isSystemDetail && scanId
      ? `detail:${scanId}`
      : scanId
      ? `scan:${scanId}`
      : `workspace:${ATLAS_WORKSPACE_ID}`;

    async function load() {
      try {
        if (isSystemDetail && scanId) {
          const [scan, detailGraph] = await Promise.all([getScan(scanId), getScanGraph(scanId)]);
          if (cancelled) return;
          setGraphLoad({
            key,
            graph: detailGraph,
            repoLabel: `${scan.repoUrl.replace(/^https:\/\/github\.com\//, "")} · detail`,
            apiNotice: null,
          });
          return;
        }

        if (scanId) {
          const scan = await getScan(scanId);
          const workspaceGraph = await getWorkspaceGraph(scan.workspaceId);
          if (cancelled) return;
          const repoCount = workspaceGraph.repositories.length;
          setGraphLoad({
            key,
            graph: workspaceGraph,
            repoLabel: repoCount === 1
              ? scan.repoUrl.replace(/^https:\/\/github\.com\//, "")
              : `${repoCount} repos · workspace:${workspaceGraph.workspaceId}`,
            apiNotice: null,
          });
          return;
        }

        const workspaceGraph = await getWorkspaceGraph();
        if (cancelled) return;
        const repoCount = workspaceGraph.repositories.length;
        setGraphLoad({
          key,
          graph: workspaceGraph,
          repoLabel: repoCount === 1
            ? workspaceGraph.repositories[0].url.replace(/^https:\/\/github\.com\//, "")
            : `${repoCount} repos · workspace:${workspaceGraph.workspaceId}`,
          apiNotice: null,
        });
      } catch (err) {
        if (!cancelled) {
          setGraphLoad({
            key,
            graph: null,
            repoLabel: scanId ?? `workspace:${ATLAS_WORKSPACE_ID}`,
            apiNotice: err instanceof Error ? err.message : "Unable to load real backend graph",
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [isSystemDetail, scanId]);

  const graphKey = isSystemDetail && scanId
    ? `detail:${scanId}`
    : scanId
    ? `scan:${scanId}`
    : `workspace:${ATLAS_WORKSPACE_ID}`;
  const activeGraphLoad = graphLoad?.key === graphKey ? graphLoad : null;
  const graph = activeGraphLoad?.graph ?? EMPTY_GRAPH;
  const repoLabel = activeGraphLoad?.repoLabel ?? `workspace:${ATLAS_WORKSPACE_ID}`;
  const displayRepoLabel = isSystemDetail ? repoLabel.replace(/ · detail$/, "") : repoLabel;
  const isGraphLoading = !activeGraphLoad;
  const apiNotice = activeGraphLoad?.apiNotice ?? (isGraphLoading ? "Loading real graph…" : null);
  const graphUnavailable = Boolean(activeGraphLoad && activeGraphLoad.apiNotice && !activeGraphLoad.graph);
  const graphEmpty = Boolean(activeGraphLoad && !activeGraphLoad.apiNotice && graph.nodes.length === 0);
  const nodeByIdForGraph = React.useCallback(
    (id: string) => nodeByIdIn(graph, id),
    [graph],
  );
  const dependenciesForGraph = React.useCallback(
    (id: string) => dependenciesOfIn(graph, id),
    [graph],
  );
  const dependentsForGraph = React.useCallback(
    (id: string) => dependentsOfIn(graph, id),
    [graph],
  );

  // Select from main graph and reset drill history.
  const selectNode = React.useCallback((id: string) => {
    setNodeHistory([]);
    setPanelView("overview");
    if (!id) { setSelectedNodeId(null); setSelectedLinkId(null); return; }
    setSelectedLinkId(null);
    setSelectedNodeId(id);
  }, []);

  // Drill down from sub-graph — adds current node to breadcrumb history
  const drillDown = React.useCallback((id: string) => {
    setSelectedNodeId((current) => {
      if (current) {
        const currentNode = nodeByIdForGraph(current);
        if (currentNode) {
          setNodeHistory((h) => [...h, currentNode]);
        }
      }
      return id;
    });
    setPanelView("subgraph");
    setSelectedLinkId(null);
  }, [nodeByIdForGraph]);

  // Go back one level in drill history
  const goBack = React.useCallback(() => {
    setNodeHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setSelectedNodeId(prev.id);
      setSelectedLinkId(null);
      return h.slice(0, -1);
    });
  }, []);

  // Double-click a system node to enter its scan-level graph; inside a system it opens the local sub-graph.
  const handleDoubleClickNode = React.useCallback((id: string) => {
    const node = nodeByIdForGraph(id);
    if (!isSystemDetail && node?.scanId) {
      setNodeHistory([]);
      setSelectedLinkId(null);
      setSelectedNodeId(null);
      router.push(`/explore?scanId=${encodeURIComponent(node.scanId)}&view=detail`);
      return;
    }

    setNodeHistory([]);
    setSelectedLinkId(null);
    setSelectedNodeId(id);
    setPanelView("subgraph");
    graphRef.current?.focusNode(id);
  }, [isSystemDetail, nodeByIdForGraph, router]);

  const selectLink = React.useCallback((id: string) => {
    setSelectedNodeId(null);
    setSelectedLinkId(id);
  }, []);

  const toggleKind = (k: NodeKind) =>
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        next.delete(k);
      } else {
        next.add(k);
      }
      return next;
    });

  // ── Keyboard navigation ──────────────────────────────────────────────────
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't intercept when typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;

      if (e.key === "Escape") {
        selectNode("");
        return;
      }

      if (!selectedNodeId) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const deps = dependenciesForGraph(selectedNodeId);
        if (deps.length > 0) {
          const next = deps[0].target;
          setSelectedNodeId(next);
          setSelectedLinkId(null);
          setNodeHistory([]);
          setPanelView("overview");
          graphRef.current?.focusNode(next);
        }
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const parents = dependentsForGraph(selectedNodeId);
        if (parents.length > 0) {
          const prev = parents[0].source;
          setSelectedNodeId(prev);
          setSelectedLinkId(null);
          setNodeHistory([]);
          setPanelView("overview");
          graphRef.current?.focusNode(prev);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dependenciesForGraph, dependentsForGraph, selectedNodeId, selectNode]);

  const filtered: GraphData = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const nodes = graph.nodes.filter((n) => {
      if (!activeKinds.has(n.kind)) return false;
      if (highRiskOnly && n.risks.length === 0) return false;
      if (q && !(
        n.label.toLowerCase().includes(q) ||
        n.domain.toLowerCase().includes(q) ||
        n.whatItIs.toLowerCase().includes(q) ||
        n.kind.toLowerCase().includes(q)
      )) return false;
      return true;
    });
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, links: graph.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }, [query, activeKinds, highRiskOnly, graph]);

  const selectedNode = selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const selectedLink = selectedLinkId ? graph.links.find((l) => l.id === selectedLinkId) ?? null : null;
  const panelOpen = Boolean(selectedNode || selectedLink);
  const highRiskCount = graph.nodes.filter((n) => n.risks.length > 0).length;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0c0d10]">
      {(isGraphLoading || graphUnavailable || graphEmpty) && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0c0d10] px-6">
          <div className="max-w-md rounded-lg border border-[#2a2c36] bg-[#181a22] p-5">
            <p className="mb-2 text-sm font-semibold text-[#e8e9ed]">
              {isGraphLoading
                ? "Loading real graph"
                : graphEmpty
                ? "No real scan data yet"
                : scanId
                ? "Real scan unavailable"
                : "Real workspace unavailable"}
            </p>
            <p className="text-[13px] leading-relaxed text-[#8b8d98]">
              {graphEmpty ? "Run a repository scan to populate the workspace graph." : apiNotice}
            </p>
            <Link href="/" className="mt-4 inline-flex rounded-lg bg-[#818cf8] px-3 py-1.5 text-[13px] font-semibold text-white">
              {graphEmpty ? "Start a scan" : "Start another scan"}
            </Link>
          </div>
        </div>
      )}
      {/* Graph canvas */}
      <div className="absolute inset-0">
        <Graph3D
          ref={graphRef}
          data={filtered}
          selectedNodeId={selectedNodeId}
          selectedLinkId={selectedLinkId}
          onSelectNode={selectNode}
          onSelectLink={selectLink}
          onDoubleClickNode={handleDoubleClickNode}
          criticalPathMode={false}
          criticalPathNodeIds={EMPTY_SET}
          criticalPathLinkIds={EMPTY_SET}
        />
      </div>

      {/* ── Top toolbar ── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
        {/* Primary bar */}
        <div className="pointer-events-auto border-b border-[#2a2c36] bg-[#0c0d10]/90 backdrop-blur-sm">
          <div className="mx-auto flex min-h-11 max-w-[1600px] flex-wrap items-center gap-2 px-3 py-2 sm:h-11 sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-0">
            <div className="shrink-0">
              <Logo />
            </div>
            <div className="h-4 w-px bg-[#2a2c36]" />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-[#5c5e6a]">
              {isSystemDetail ? (
                <>
                  <Link
                    href="/explore"
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[#2a2c36] px-2 py-1 font-mono text-[12px] text-[#8b8d98] transition-colors duration-150 hover:border-[#3a3c48] hover:text-[#e8e9ed]"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    Workspace
                  </Link>
                  <span className="shrink-0 font-mono text-[12px] text-[#3a3c48]">/</span>
                  <GithubMark className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden truncate font-mono sm:inline">{displayRepoLabel}</span>
                  <span className="hidden rounded-md border border-[#2a2c36] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[#5c5e6a] md:inline">
                    Inside system
                  </span>
                </>
              ) : (
                <>
                  <GithubMark className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden truncate font-mono sm:inline">{displayRepoLabel}</span>
                  <span className="hidden rounded-md border border-[#2a2c36] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[#5c5e6a] md:inline">
                    System map
                  </span>
                </>
              )}
            </div>
            <div className="flex w-full min-w-0 items-center gap-1.5 sm:ml-auto sm:w-auto sm:justify-end sm:gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-[#2a2c36] bg-[#181a22] sm:flex-none">
                <Search className="ml-2.5 h-3.5 w-3.5 shrink-0 text-[#5c5e6a]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search nodes…"
                  className="w-full min-w-0 bg-transparent py-1.5 pr-2 text-[13px] text-[#e8e9ed] placeholder:text-[#5c5e6a] focus:outline-none sm:w-48"
                />
                {query && (
                  <button onClick={() => setQuery("")} aria-label="Clear" className="cursor-pointer px-1.5 text-[#5c5e6a] hover:text-[#8b8d98]">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="hidden rounded-lg border border-[#2a2c36] bg-[#181a22] sm:flex">
                <button
                  onClick={() => graphRef.current?.zoomOut()}
                  aria-label="Zoom out"
                  className="flex h-[29px] w-8 cursor-pointer items-center justify-center border-r border-[#2a2c36] text-[#8b8d98] transition-colors duration-150 hover:text-[#e8e9ed]"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => graphRef.current?.zoomIn()}
                  aria-label="Zoom in"
                  className="flex h-[29px] w-8 cursor-pointer items-center justify-center border-r border-[#2a2c36] text-[#8b8d98] transition-colors duration-150 hover:text-[#e8e9ed]"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => { selectNode(""); graphRef.current?.resetView(); }}
                  aria-label="Reset zoom"
                  className="flex h-[29px] cursor-pointer items-center gap-1.5 px-2.5 text-[13px] text-[#8b8d98] transition-colors duration-150 hover:text-[#e8e9ed]"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Reset</span>
                </button>
              </div>
              {scanId ? (
                <Link
                  href={`/export?scanId=${encodeURIComponent(scanId)}`}
                  aria-label="Export context"
                  title="Export context"
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#818cf8] px-2.5 py-1.5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-[#6366f1]"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Export context</span>
                </Link>
              ) : (
                <Link
                  href="/"
                  aria-label="Scan to export"
                  title="Scan to export"
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#818cf8] px-2.5 py-1.5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-[#6366f1]"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Scan to export</span>
                </Link>
              )}
              <button
                type="button"
                aria-label="Open handoff assistant"
                title="Open handoff assistant"
                onClick={() => setChatOpen((value) => !value)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 text-[13px] font-semibold transition-colors duration-150",
                  chatOpen
                    ? "border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#3b82f6]"
                    : "border-[#2a2a2a] bg-[#111] text-[#888] hover:text-[#ededed]",
                )}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Handoff</span>
              </button>
            </div>
          </div>
        </div>

        {/* Filter bar */}
        <div className="pointer-events-auto border-b border-[#2a2c36] bg-[#0c0d10]/80 backdrop-blur-sm">
          <div className="mx-auto flex h-9 max-w-[1600px] items-center gap-1.5 overflow-x-auto px-4">
            {ALL_KINDS.map((k) => {
              const meta = NODE_KIND_META[k];
              const Icon = NODE_ICON[k];
              const on = activeKinds.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors duration-150",
                    on
                      ? "border-transparent text-[#181a22]"
                      : "border-[#2a2c36] text-[#5c5e6a] hover:text-[#8b8d98]",
                  )}
                  style={on ? { backgroundColor: meta.color, color: meta.color === "#e8e9ed" ? "#0c0d10" : "#fff" } : undefined}
                >
                  <Icon className="h-3 w-3" />
                  {meta.label}
                </button>
              );
            })}
            <div className="h-4 w-px shrink-0 bg-[#2a2c36]" />
            <button
              onClick={() => setHighRiskOnly((v) => !v)}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors duration-150",
                highRiskOnly
                  ? "border-[#fbbf24]/40 bg-[#fbbf24]/10 text-[#fbbf24]"
                  : "border-[#2a2c36] text-[#5c5e6a] hover:text-[#8b8d98]",
              )}
            >
              <ShieldAlert className="h-3 w-3" />
              High-risk · {highRiskCount}
            </button>
          </div>
        </div>
      </div>

      {/* ── Compact side legend ── */}
      <div className="pointer-events-none absolute left-3 top-28 z-20 hidden sm:block">
        <div className="pointer-events-auto w-44 rounded-lg border border-[#2a2c36] bg-[#0c0d10]/90 p-2.5 backdrop-blur-sm">
          <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-[#5c5e6a]">Groups</p>
          <div className="space-y-1.5">
            {NODE_GROUPS.map((g) => (
              <div key={g.key} className="group relative flex items-center gap-2">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                <span className="text-[11px] font-medium" style={{ color: g.color }}>{g.key}</span>
                <span className="ml-auto font-mono text-[10px] text-[#5c5e6a]">
                  {g.key === "Internal" ? "code" : g.key === "Infrastructure" ? "data" : "apis"}
                </span>
                <span className="pointer-events-none absolute left-full top-1/2 ml-2 hidden w-56 -translate-y-1/2 rounded-lg border border-[#2a2c36] bg-[#12131a] p-2 text-[11px] leading-relaxed text-[#8b8d98] group-hover:block">
                  {g.desc}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-2.5 border-t border-[#2a2c36] pt-2">
            <p className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-[#5c5e6a]">Edges</p>
            <div className="space-y-1">
              {(Object.keys(EDGE_KIND_META) as Array<keyof typeof EDGE_KIND_META>).map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="h-px w-3 shrink-0" style={{ backgroundColor: EDGE_KIND_META[k].color }} />
                  <span className="truncate text-[10px] text-[#8b8d98]">{EDGE_KIND_META[k].label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[#2a2c36] pt-2">
            {(Object.keys(CONFIDENCE_META) as Array<keyof typeof CONFIDENCE_META>).map((k) => (
              <div key={k} className="flex items-center gap-1 text-[10px] text-[#8b8d98]">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CONFIDENCE_META[k].color }} />
                {CONFIDENCE_META[k].label}
              </div>
            ))}
          </div>

          {/* Keyboard shortcuts */}
          <div className="mt-2.5 border-t border-[#2a2c36] pt-2">
            <p className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-[#5c5e6a]">Keys</p>
            <div className="space-y-1">
              {[
                { key: "↑ / ↓", label: "Traverse" },
                { key: "Dbl-click", label: isSystemDetail ? "Sub-graph" : "Enter" },
                { key: "Esc", label: "Deselect" },
              ].map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-2">
                  <span className="rounded bg-[#1e2028] px-1 font-mono text-[9px] text-[#5c5e6a]">{s.key}</span>
                  <span className="text-[10px] text-[#5c5e6a]">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Bottom-center hint ── */}
      {!panelOpen && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 w-[calc(100vw-24px)] max-w-xl -translate-x-1/2">
          <div className="rounded-lg border border-[#2a2c36] bg-[#0c0d10]/80 px-3.5 py-2 text-center font-mono text-[12px] text-[#5c5e6a] backdrop-blur-sm">
              {apiNotice ?? (selectedNodeId
              ? "↑ parent  ↓ next dep  dbl-click sub-graph  Esc deselect"
              : isSystemDetail
              ? "Inside system · click Workspace to go back up · double-click a node for sub-graph"
              : "System map · double-click a system to enter · drag to pan · scroll to zoom")}
          </div>
        </div>
      )}

      {/* ── Stats ── */}
      <div className={cn(
        "pointer-events-none absolute right-3 top-28 z-10 hidden transition-opacity duration-200 sm:block",
        panelOpen && "opacity-0",
      )}>
        <div className="rounded-lg border border-[#2a2c36] bg-[#0c0d10]/90 p-3 backdrop-blur-sm">
          <div className="flex gap-5">
            {[
              { label: "Nodes", value: filtered.nodes.length },
              { label: "Edges", value: filtered.links.length },
              { label: "External", value: filtered.nodes.filter((n) => n.kind === "external").length },
            ].map((s) => (
              <div key={s.label}>
                <p className="font-mono text-xl font-semibold tabular-nums text-[#e8e9ed]">{s.value}</p>
                <p className="font-mono text-[10px] uppercase tracking-wide text-[#5c5e6a]">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right detail panel ── */}
      {panelOpen && (
        <div
          data-testid="detail-panel"
          className="absolute inset-x-2 bottom-2 top-auto z-30 h-[45dvh] border border-[#2a2c36] sm:inset-x-auto sm:right-0 sm:top-20 sm:h-[calc(100%-5rem)] sm:w-full sm:max-w-[400px] sm:border-y-0 sm:border-r-0 sm:border-l"
        >
          <div className="h-full overflow-hidden rounded-xl bg-[#181a22] animate-slide-right sm:rounded-l-xl sm:rounded-r-none">
            {selectedNode && (
              <NodePanel
                node={selectedNode}
                graph={graph}
                onClose={() => selectNode("")}
                onFocus={() => graphRef.current?.focusNode(selectedNode.id)}
                onSelectLink={selectLink}
                onDrillDown={drillDown}
                nodeHistory={nodeHistory}
                onGoBack={goBack}
                view={panelView}
                onViewChange={setPanelView}
              />
            )}
            {selectedLink && (
              <LinkPanel
                link={selectedLink}
                graph={graph}
                onClose={() => selectNode("")}
                onSelectNode={selectNode}
              />
            )}
          </div>
        </div>
      )}

      <ChatPanel
        open={chatOpen}
        scanId={scanId}
        selectedNode={selectedNode}
        selectedLink={selectedLink}
        detailsOpen={panelOpen}
        onClose={() => setChatOpen(false)}
        onSelectNode={(id) => {
          selectNode(id);
          graphRef.current?.focusNode(id);
        }}
        onSelectLink={selectLink}
      />
    </main>
  );
}
