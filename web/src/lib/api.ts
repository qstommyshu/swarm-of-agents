import type { Confidence, GraphData } from "./data";

export const ATLAS_API_URL =
  process.env.NEXT_PUBLIC_ATLAS_API_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:3001";
const ATLAS_API_AUTH_TOKEN = process.env.NEXT_PUBLIC_ATLAS_API_AUTH_TOKEN?.trim();

export const ATLAS_WORKSPACE_ID =
  process.env.NEXT_PUBLIC_ATLAS_WORKSPACE_ID?.trim() || "default";

export interface ScanRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  repoUrl: string;
  commitSha?: string | null;
  status: "queued" | "running" | "completed" | "failed";
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  backboardAssistantId?: string | null;
  backboardThreadId?: string | null;
  backboardRunId?: string | null;
}

export interface RepositoryRecord {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  url: string;
  cloneUrl: string;
  packageName?: string | null;
  lastCommitSha?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGraph extends GraphData {
  workspaceId: string;
  repositories: RepositoryRecord[];
  crossRepoConnections: Array<{
    id: string;
    sourceRepositoryId: string;
    targetRepositoryId: string;
    sourcePackage: string;
    targetPackage: string;
    summary: string;
  }>;
}

export interface ScanEvent {
  id?: number;
  scanId: string;
  type: "queued" | "clone" | "scan" | "backboard" | "persist" | "complete" | "error";
  message: string;
  createdAt: string;
}

export interface ExportResponse {
  scanId: string;
  files: Array<{ path: string; markdown: string }>;
  combinedMarkdown: string;
}

export interface ChatCitation {
  id: string;
  stableId?: string;
  label: string;
  subjectType: "node" | "edge" | "repo" | "workspace";
  subjectId?: string;
  repositoryId?: string;
  scanId?: string;
  commitSha?: string | null;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  detector?: string;
  confidenceReason?: string;
  confidence?: Confidence;
}

export interface ChatSession {
  id: string;
  workspaceId: string;
  title: string;
  assistantId: string;
  threadId?: string | null;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[];
  backboardRunId?: string | null;
  backboardMessageId?: string | null;
  memoryOperationId?: string | null;
  memoryError?: string | null;
  createdAt: string;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ATLAS_API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(ATLAS_API_AUTH_TOKEN ? { Authorization: `Bearer ${ATLAS_API_AUTH_TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.text();
  const parsed = body ? JSON.parse(body) : {};
  if (!response.ok) {
    throw new Error(parsed?.message ?? `Atlas API returned ${response.status}`);
  }
  return parsed as T;
}

export function createScan(repoUrl: string): Promise<ScanRecord> {
  return apiJson<ScanRecord>("/api/scans", {
    method: "POST",
    body: JSON.stringify({ repoUrl }),
  });
}

export function getScan(scanId: string): Promise<ScanRecord> {
  return apiJson<ScanRecord>(`/api/scans/${encodeURIComponent(scanId)}`);
}

export function getScanEvents(scanId: string): Promise<{ scanId: string; events: ScanEvent[] }> {
  return apiJson<{ scanId: string; events: ScanEvent[] }>(`/api/scans/${encodeURIComponent(scanId)}/events`);
}

export function getScanGraph(scanId: string): Promise<GraphData> {
  return apiJson<GraphData>(`/api/scans/${encodeURIComponent(scanId)}/graph`);
}

export function getWorkspaceGraph(workspaceId = ATLAS_WORKSPACE_ID): Promise<WorkspaceGraph> {
  return apiJson<WorkspaceGraph>(`/api/workspaces/${encodeURIComponent(workspaceId)}/graph`);
}

export function getScanExport(scanId: string): Promise<ExportResponse> {
  return apiJson<ExportResponse>(`/api/scans/${encodeURIComponent(scanId)}/export`);
}

export function createChatSession(input: {
  title?: string;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
}): Promise<ChatSession> {
  return apiJson<ChatSession>("/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getChatMessages(sessionId: string): Promise<{ sessionId: string; messages: ChatMessage[] }> {
  return apiJson<{ sessionId: string; messages: ChatMessage[] }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

export function sendChatMessage(
  sessionId: string,
  input: { content: string; nodeId?: string | null; edgeId?: string | null; scanId?: string | null },
): Promise<{ session: ChatSession; userMessage: ChatMessage; assistantMessage: ChatMessage }> {
  return apiJson<{ session: ChatSession; userMessage: ChatMessage; assistantMessage: ChatMessage }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
