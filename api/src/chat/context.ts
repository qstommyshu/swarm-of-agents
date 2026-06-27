import type { AtlasRepository } from "../db/database.js";
import { nodeContextMarkdown, edgeContextMarkdown } from "../graph/context.js";
import { buildWorkspaceGraph } from "../graph/workspace.js";
import type {
  ChatCitation,
  ChatContextBundle,
  ChatContextSubject,
  ChatMessageRecord,
  Evidence,
  GraphLink,
  GraphNode,
  RepositoryRecord,
  ScanRecord,
} from "../types/domain.js";
import { redactSecrets } from "../util/redact.js";
import { stableId } from "../util/ids.js";

const MAX_NODES = 8;
const MAX_EDGES = 10;
const MAX_EVIDENCE = 18;

function tokens(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9@._/-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function includesToken(text: string, queryTokens: string[]): number {
  const lower = text.toLowerCase();
  return queryTokens.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0);
}

function repoLabel(repo: RepositoryRecord): string {
  return `${repo.owner}/${repo.name}`;
}

function selectedSubject(input: {
  workspaceId: string;
  scanId?: string | null;
  nodeId?: string | null;
  edgeId?: string | null;
}): ChatContextSubject {
  if (input.nodeId) return { type: "node", id: input.nodeId };
  if (input.edgeId) return { type: "edge", id: input.edgeId };
  if (input.scanId) return { type: "scan", id: input.scanId };
  return { type: "workspace", id: input.workspaceId };
}

function scanByRepo(scans: ScanRecord[]): Map<string, ScanRecord> {
  return new Map(scans.map((scan) => [scan.repositoryId, scan]));
}

function evidenceKey(citation: ChatCitation): string {
  return [
    citation.subjectType,
    citation.subjectId ?? "",
    citation.filePath ?? "",
    citation.lineStart ?? "",
    citation.lineEnd ?? "",
    citation.snippet ?? "",
  ].join("\u0000");
}

function citationFromEvidence(args: {
  index: number;
  subjectType: "node" | "edge" | "repo" | "workspace";
  subjectId?: string;
  repositoryId?: string;
  scan?: ScanRecord;
  label: string;
  confidence?: ChatCitation["confidence"];
  evidence: Evidence;
}): ChatCitation {
  return {
    id: `E${args.index}`,
    stableId: args.evidence.id ?? stableId(
      "evidence",
      args.subjectType,
      args.subjectId ?? "",
      args.repositoryId ?? "",
      args.scan?.id ?? "",
      args.scan?.commitSha ?? "",
      args.evidence.filePath,
      args.evidence.lineStart,
      args.evidence.lineEnd,
      args.evidence.snippet,
    ),
    label: args.label,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    repositoryId: args.repositoryId,
    scanId: args.scan?.id,
    commitSha: args.scan?.commitSha ?? null,
    filePath: args.evidence.filePath,
    lineStart: args.evidence.lineStart,
    lineEnd: args.evidence.lineEnd,
    snippet: redactSecrets(args.evidence.snippet).slice(0, 600),
    detector: args.evidence.detector,
    confidenceReason: args.evidence.confidenceReason,
    confidence: args.confidence,
  };
}

function topScored<T>(items: T[], score: (item: T) => number, limit: number): T[] {
  return items
    .map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function nodeScore(node: GraphNode, args: {
  queryTokens: string[];
  selected: ChatContextSubject;
  repos: Map<string, RepositoryRecord>;
  selectedScanId?: string | null;
}): number {
  let score = 0;
  if (args.selected.type === "node" && args.selected.id === node.id) score += 100;
  if (args.selected.type === "scan" && args.selected.id === node.scanId) score += 35;
  if (args.selectedScanId && args.selectedScanId === node.scanId) score += 25;
  score += includesToken(node.id, args.queryTokens) * 8;
  score += includesToken(node.label, args.queryTokens) * 12;
  score += includesToken(node.kind, args.queryTokens) * 4;
  score += includesToken(node.domain, args.queryTokens) * 4;
  score += includesToken(node.whatItIs, args.queryTokens) * 3;
  score += includesToken(node.whyItExists, args.queryTokens) * 2;
  score += includesToken(node.owns.join(" "), args.queryTokens) * 4;
  score += includesToken(node.risks.join(" "), args.queryTokens) * 6;
  score += includesToken((node.evidence ?? []).map((evidence) => `${evidence.filePath} ${evidence.snippet}`).join(" "), args.queryTokens) * 3;
  const repo = node.repositoryId ? args.repos.get(node.repositoryId) : undefined;
  if (repo) {
    score += includesToken(`${repoLabel(repo)} ${repo.packageName ?? ""}`, args.queryTokens) * 10;
  }
  return score;
}

function edgeScore(edge: GraphLink, args: {
  queryTokens: string[];
  selected: ChatContextSubject;
  nodesById: Map<string, GraphNode>;
  repos: Map<string, RepositoryRecord>;
  selectedScanId?: string | null;
}): number {
  let score = 0;
  if (args.selected.type === "edge" && args.selected.id === edge.id) score += 100;
  if (args.selected.type === "node" && (edge.source === args.selected.id || edge.target === args.selected.id)) score += 40;
  if (args.selected.type === "scan" && args.selected.id === edge.scanId) score += 35;
  if (args.selectedScanId && args.selectedScanId === edge.scanId) score += 25;
  score += includesToken(edge.id, args.queryTokens) * 8;
  score += includesToken(edge.kind, args.queryTokens) * 5;
  score += includesToken(edge.summary, args.queryTokens) * 6;
  score += includesToken(edge.contract, args.queryTokens) * 7;
  score += includesToken(edge.failure, args.queryTokens) * 3;
  score += includesToken(edge.risks.join(" "), args.queryTokens) * 8;
  score += includesToken(edge.codePath, args.queryTokens) * 3;
  score += includesToken(edge.code, args.queryTokens) * 2;
  score += includesToken((edge.evidence ?? []).map((evidence) => `${evidence.filePath} ${evidence.snippet}`).join(" "), args.queryTokens) * 3;

  const source = args.nodesById.get(edge.source);
  const target = args.nodesById.get(edge.target);
  if (source) score += includesToken(`${source.label} ${source.domain}`, args.queryTokens) * 7;
  if (target) score += includesToken(`${target.label} ${target.domain}`, args.queryTokens) * 7;
  const repo = edge.repositoryId ? args.repos.get(edge.repositoryId) : undefined;
  if (repo) score += includesToken(`${repoLabel(repo)} ${repo.packageName ?? ""}`, args.queryTokens) * 8;
  return score;
}

function expandNeighborhood(nodes: GraphNode[], edges: GraphLink[]): { nodes: GraphNode[]; edges: GraphLink[] } {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const neighborhoodEdges = edges.filter((edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target));
  return {
    nodes,
    edges: neighborhoodEdges.filter((edge, index, list) => list.findIndex((item) => item.id === edge.id) === index),
  };
}

function contextMarkdown(args: {
  question: string;
  repos: RepositoryRecord[];
  nodes: GraphNode[];
  edges: GraphLink[];
  citations: ChatCitation[];
  memoryFacts: string[];
}): string {
  const lines = [
    `# Atlas Chat Context`,
    ``,
    `Question: ${args.question}`,
    ``,
    `## Repositories`,
    ...(args.repos.length > 0
      ? args.repos.map((repo) => `- ${repoLabel(repo)}${repo.packageName ? ` (${repo.packageName})` : ""}${repo.lastCommitSha ? ` @ ${repo.lastCommitSha.slice(0, 12)}` : ""}`)
      : ["- No completed repository scans are available."]),
    ``,
    `## Relevant Nodes`,
    ...(args.nodes.length > 0 ? args.nodes.map(nodeContextMarkdown) : ["No relevant nodes matched."]),
    ``,
    `## Relevant Edges`,
    ...(args.edges.length > 0 ? args.edges.map(edgeContextMarkdown) : ["No relevant edges matched."]),
    ``,
    `## Evidence Citations`,
    ...(args.citations.length > 0
      ? args.citations.map((citation) => {
          const location = citation.filePath ? `${citation.filePath}:L${citation.lineStart ?? 1}` : "graph";
          return `- [${citation.id}] ${citation.label} - ${location} - ${citation.snippet ?? ""}`;
        })
      : ["- No direct evidence matched this question."]),
    ``,
    `## Known Backboard Memory Facts`,
    ...(args.memoryFacts.length > 0 ? args.memoryFacts.map((fact) => `- ${fact}`) : ["- No stored memory facts are locally indexed yet."]),
  ];
  return lines.join("\n");
}

export function formatCitationList(citations: ChatCitation[]): string {
  if (citations.length === 0) return "No direct evidence matched.";
  return citations
    .map((citation) => {
      const location = citation.filePath ? `${citation.filePath}:L${citation.lineStart ?? 1}` : citation.subjectType;
      return `[${citation.id}] ${citation.label} (${location})`;
    })
    .join("\n");
}

export function buildChatContext(args: {
  repository: AtlasRepository;
  workspaceId: string;
  question: string;
  sessionMessages?: ChatMessageRecord[];
  nodeId?: string | null;
  edgeId?: string | null;
  scanId?: string | null;
}): ChatContextBundle {
  const repos = args.repository.listRepositories(args.workspaceId);
  const latestScans = args.repository.listLatestCompletedScans(args.workspaceId);
  const workspace = buildWorkspaceGraph({
    workspaceId: args.workspaceId,
    repositories: repos,
    scans: latestScans,
  });

  const queryTokens = tokens(args.question);
  const selected = selectedSubject({
    workspaceId: args.workspaceId,
    scanId: args.scanId,
    nodeId: args.nodeId,
    edgeId: args.edgeId,
  });
  const reposById = new Map(repos.map((repo) => [repo.id, repo]));
  const latestScanByRepoId = scanByRepo(latestScans);
  const allScanNodes = latestScans.flatMap((scan) => scan.graph?.nodes ?? []);
  const allScanLinks = latestScans.flatMap((scan) => scan.graph?.links ?? []);
  const allNodes = [
    ...workspace.nodes,
    ...allScanNodes.filter((node) => !workspace.nodes.some((item) => item.id === node.id)),
  ];
  const allLinks = [
    ...workspace.links,
    ...allScanLinks.filter((edge) => !workspace.links.some((item) => item.id === edge.id)),
  ];
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  const edgesById = new Map(allLinks.map((edge) => [edge.id, edge]));

  let nodes = topScored(
    args.scanId ? allNodes : workspace.nodes,
    (node) => nodeScore(node, { queryTokens, selected, repos: reposById, selectedScanId: args.scanId }),
    MAX_NODES,
  );
  let edges = topScored(
    args.scanId ? allLinks : workspace.links,
    (edge) => edgeScore(edge, { queryTokens, selected, nodesById, repos: reposById, selectedScanId: args.scanId }),
    MAX_EDGES,
  );

  if (args.scanId) {
    const scan = latestScans.find((item) => item.id === args.scanId);
    if (scan?.graph) {
      nodes = [
        ...scan.graph.nodes,
        ...nodes.filter((node) => !scan.graph?.nodes.some((item) => item.id === node.id)),
      ].slice(0, MAX_NODES);
      edges = [
        ...scan.graph.links,
        ...edges.filter((edge) => !scan.graph?.links.some((item) => item.id === edge.id)),
      ].slice(0, MAX_EDGES);
    }
  }

  if (selected.type === "node") {
    const node = nodesById.get(selected.id);
    if (node && !nodes.some((item) => item.id === node.id)) nodes = [node, ...nodes].slice(0, MAX_NODES);
  }
  if (selected.type === "edge") {
    const edge = edgesById.get(selected.id);
    if (edge && !edges.some((item) => item.id === edge.id)) edges = [edge, ...edges].slice(0, MAX_EDGES);
  }

  const expanded = expandNeighborhood(nodes, allLinks);
  nodes = expanded.nodes;
  edges = [...edges, ...expanded.edges]
    .filter((edge, index, list) => list.findIndex((item) => item.id === edge.id) === index)
    .slice(0, MAX_EDGES);

  const citations: ChatCitation[] = [];
  const seenEvidence = new Set<string>();
  for (const node of nodes) {
    for (const evidence of node.evidence ?? []) {
      const citation = citationFromEvidence({
        index: citations.length + 1,
        subjectType: "node",
        subjectId: node.id,
        repositoryId: node.repositoryId,
        scan: node.repositoryId ? latestScanByRepoId.get(node.repositoryId) : undefined,
        label: node.label,
        confidence: node.confidence,
        evidence,
      });
      const key = evidenceKey(citation);
      if (!seenEvidence.has(key)) {
        seenEvidence.add(key);
        citations.push(citation);
      }
      if (citations.length >= MAX_EVIDENCE) break;
    }
    if (citations.length >= MAX_EVIDENCE) break;
  }
  for (const edge of edges) {
    for (const evidence of edge.evidence ?? []) {
      const source = nodesById.get(edge.source)?.label ?? edge.source;
      const target = nodesById.get(edge.target)?.label ?? edge.target;
      const citation = citationFromEvidence({
        index: citations.length + 1,
        subjectType: "edge",
        subjectId: edge.id,
        repositoryId: edge.repositoryId,
        scan: edge.repositoryId ? latestScanByRepoId.get(edge.repositoryId) : undefined,
        label: `${source} -> ${target}`,
        confidence: edge.confidence,
        evidence,
      });
      const key = evidenceKey(citation);
      if (!seenEvidence.has(key)) {
        seenEvidence.add(key);
        citations.push(citation);
      }
      if (citations.length >= MAX_EVIDENCE) break;
    }
    if (citations.length >= MAX_EVIDENCE) break;
  }

  const relevantRepoIds = new Set([
    ...nodes.map((node) => node.repositoryId).filter((id): id is string => Boolean(id)),
    ...edges.map((edge) => edge.repositoryId).filter((id): id is string => Boolean(id)),
  ]);
  if (args.scanId) {
    const scan = latestScans.find((item) => item.id === args.scanId);
    if (scan) relevantRepoIds.add(scan.repositoryId);
  }
  const relevantRepos = repos.filter((repo) => relevantRepoIds.has(repo.id));
  const finalRepos = relevantRepos.length > 0 ? relevantRepos : repos.slice(0, 6);
  const previousMessages = (args.sessionMessages ?? [])
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: redactSecrets(message.content).slice(0, 1600),
      createdAt: message.createdAt,
    }));
  const memoryFacts = args.repository.listBackboardMemoryFacts(args.workspaceId);

  return {
    workspaceId: args.workspaceId,
    question: args.question,
    graphSummary: {
      repositories: repos.length,
      scans: latestScans.length,
      nodes: workspace.nodes.length,
      edges: workspace.links.length,
      crossRepoConnections: workspace.crossRepoConnections.length,
    },
    repositories: finalRepos.map((repo) => ({
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      packageName: repo.packageName,
      lastCommitSha: repo.lastCommitSha,
    })),
    selected,
    nodes,
    edges,
    evidence: citations,
    generatedMarkdown: contextMarkdown({
      question: args.question,
      repos: finalRepos,
      nodes,
      edges,
      citations,
      memoryFacts,
    }),
    previousMessages,
    memoryFacts,
    weakEvidence: citations.length === 0 || [...nodes.map((node) => node.confidence), ...edges.map((edge) => edge.confidence)].includes("uncertain"),
  };
}
