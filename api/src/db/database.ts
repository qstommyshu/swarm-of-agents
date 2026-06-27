import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  BackboardSynthesis,
  ChatCitation,
  ChatContextBundle,
  DurableMemoryFact,
  ChatMessageRecord,
  ChatRole,
  ChatSessionRecord,
  Evidence,
  GraphData,
  GraphLink,
  GraphNode,
  RepositoryRecord,
  ScanContext,
  ScanEvent,
  ScanRecord,
  ScanStatus,
} from "../types/domain.js";
import { nowIso } from "../util/time.js";

export type SqliteDatabase = Database.Database;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function isEvidenceBackedDurableFact(value: DurableMemoryFact): boolean {
  return Boolean(
    value?.fact?.trim() &&
      value.commitSha &&
      value.repo &&
      Array.isArray(value.evidenceIds) &&
      value.evidenceIds.length > 0 &&
      Array.isArray(value.evidenceRefs) &&
      value.evidenceRefs.length > 0,
  );
}

function ensureColumn(db: SqliteDatabase, tableName: string, columnName: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function openDatabase(databasePath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      backboard_assistant_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      package_name TEXT,
      last_commit_sha TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, owner, name)
    );

    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      repo_url TEXT NOT NULL,
      commit_sha TEXT,
      status TEXT NOT NULL,
      error TEXT,
      graph_json TEXT,
      context_json TEXT,
      artifacts_json TEXT,
      backboard_assistant_id TEXT,
      backboard_thread_id TEXT,
      backboard_run_id TEXT,
      backboard_response_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      stable_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      domain TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence TEXT NOT NULL,
      risks_json TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scan_id, stable_id)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      stable_id TEXT NOT NULL,
      source_stable_id TEXT NOT NULL,
      target_stable_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scan_id, stable_id)
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_stable_id TEXT NOT NULL,
      stable_id TEXT,
      file_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      snippet TEXT NOT NULL,
      detector TEXT NOT NULL,
      confidence_reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backboard_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
      scan_id TEXT REFERENCES scans(id) ON DELETE SET NULL,
      assistant_id TEXT,
      thread_id TEXT,
      run_id TEXT,
      message_id TEXT,
      memory_mode TEXT,
      memory_operation_id TEXT,
      memory_facts_json TEXT,
      request_summary TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      thread_id TEXT,
      selected_node_id TEXT,
      selected_edge_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context_json TEXT,
      citations_json TEXT NOT NULL,
      backboard_run_id TEXT,
      backboard_message_id TEXT,
      memory_operation_id TEXT,
      memory_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scans_workspace ON scans(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_scans_repo ON scans(repository_id);
    CREATE INDEX IF NOT EXISTS idx_scan_events_scan ON scan_events(scan_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_workspace ON nodes(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_stable_id ON nodes(stable_id);
    CREATE INDEX IF NOT EXISTS idx_edges_workspace ON edges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_edges_stable_id ON edges(stable_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_subject ON evidence(subject_type, subject_stable_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_stable_id ON evidence(stable_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
  `);

  ensureColumn(db, "evidence", "stable_id", "TEXT");
  ensureColumn(db, "chat_messages", "memory_error", "TEXT");
  ensureColumn(db, "backboard_records", "memory_facts_json", "TEXT");
}

export class AtlasRepository {
  constructor(private readonly db: SqliteDatabase) {}

  ensureWorkspace(id: string, name = id): void {
    const existing = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(id);
    if (existing) return;
    const now = nowIso();
    this.db
      .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, name, now, now);
  }

  getWorkspaceAssistantId(workspaceId: string): string | null {
    const row = this.db
      .prepare("SELECT backboard_assistant_id FROM workspaces WHERE id = ?")
      .get(workspaceId) as { backboard_assistant_id?: string | null } | undefined;
    return row?.backboard_assistant_id ?? null;
  }

  setWorkspaceAssistantId(workspaceId: string, assistantId: string): void {
    this.db
      .prepare("UPDATE workspaces SET backboard_assistant_id = ?, updated_at = ? WHERE id = ?")
      .run(assistantId, nowIso(), workspaceId);
  }

  upsertRepository(input: {
    id: string;
    workspaceId: string;
    owner: string;
    name: string;
    url: string;
    cloneUrl: string;
    packageName?: string | null;
    lastCommitSha?: string | null;
  }): RepositoryRecord {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO repositories
          (id, workspace_id, owner, name, url, clone_url, package_name, last_commit_sha, created_at, updated_at)
        VALUES
          (@id, @workspaceId, @owner, @name, @url, @cloneUrl, @packageName, @lastCommitSha, @now, @now)
        ON CONFLICT(workspace_id, owner, name) DO UPDATE SET
          url = excluded.url,
          clone_url = excluded.clone_url,
          package_name = COALESCE(excluded.package_name, repositories.package_name),
          last_commit_sha = COALESCE(excluded.last_commit_sha, repositories.last_commit_sha),
          updated_at = excluded.updated_at
      `)
      .run({
        ...input,
        packageName: input.packageName ?? null,
        lastCommitSha: input.lastCommitSha ?? null,
        now,
      });

    const row = this.db
      .prepare("SELECT * FROM repositories WHERE workspace_id = ? AND owner = ? AND name = ?")
      .get(input.workspaceId, input.owner, input.name) as RepositoryRow;
    return repositoryFromRow(row);
  }

  updateRepositoryPackage(repositoryId: string, packageName: string | null, commitSha: string): void {
    this.db
      .prepare("UPDATE repositories SET package_name = ?, last_commit_sha = ?, updated_at = ? WHERE id = ?")
      .run(packageName, commitSha, nowIso(), repositoryId);
  }

  listRepositories(workspaceId?: string): RepositoryRecord[] {
    const rows = workspaceId
      ? (this.db.prepare("SELECT * FROM repositories WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as RepositoryRow[])
      : (this.db.prepare("SELECT * FROM repositories ORDER BY updated_at DESC").all() as RepositoryRow[]);
    return rows.map(repositoryFromRow);
  }

  getRepository(id: string): RepositoryRecord | null {
    const row = this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
    return row ? repositoryFromRow(row) : null;
  }

  createScan(input: {
    id: string;
    workspaceId: string;
    repositoryId: string;
    repoUrl: string;
    commitSha?: string | null;
  }): ScanRecord {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO scans
          (id, workspace_id, repository_id, repo_url, commit_sha, status, created_at)
        VALUES
          (?, ?, ?, ?, ?, 'queued', ?)
      `)
      .run(input.id, input.workspaceId, input.repositoryId, input.repoUrl, input.commitSha ?? null, now);
    return this.getScan(input.id)!;
  }

  updateScanStatus(scanId: string, status: ScanStatus, error?: string | null): void {
    const now = nowIso();
    if (status === "running") {
      this.db
        .prepare("UPDATE scans SET status = ?, error = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?")
        .run(status, now, scanId);
      return;
    }
    if (status === "completed" || status === "failed") {
      this.db
        .prepare("UPDATE scans SET status = ?, error = ?, completed_at = ? WHERE id = ?")
        .run(status, error ?? null, now, scanId);
      return;
    }
    this.db.prepare("UPDATE scans SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, scanId);
  }

  completeScan(input: {
    scanId: string;
    commitSha: string;
    graph: GraphData;
    context: ScanContext;
    artifacts: unknown;
    backboard?: BackboardSynthesis | null;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        UPDATE scans SET
          status = 'completed',
          commit_sha = ?,
          graph_json = ?,
          context_json = ?,
          artifacts_json = ?,
          backboard_assistant_id = ?,
          backboard_thread_id = ?,
          backboard_run_id = ?,
          backboard_response_json = ?,
          completed_at = ?
        WHERE id = ?
      `)
      .run(
        input.commitSha,
        json(input.graph),
        json(input.context),
        json(input.artifacts),
        input.backboard?.assistantId ?? null,
        input.backboard?.threadId ?? null,
        input.backboard?.runId ?? null,
        json(input.backboard?.responseJson ?? null),
        now,
        input.scanId,
      );
  }

  getScan(scanId: string): ScanRecord | null {
    const row = this.db.prepare("SELECT * FROM scans WHERE id = ?").get(scanId) as ScanRow | undefined;
    return row ? scanFromRow(row) : null;
  }

  listLatestCompletedScans(workspaceId: string): ScanRecord[] {
    const rows = this.db
      .prepare(`
        SELECT s.*
        FROM scans s
        JOIN (
          SELECT repository_id, MAX(completed_at) AS max_completed_at
          FROM scans
          WHERE workspace_id = ? AND status = 'completed'
          GROUP BY repository_id
        ) latest
          ON latest.repository_id = s.repository_id
         AND latest.max_completed_at = s.completed_at
        ORDER BY s.completed_at DESC
      `)
      .all(workspaceId) as ScanRow[];
    return rows.map(scanFromRow);
  }

  addEvent(event: Omit<ScanEvent, "createdAt"> & { createdAt?: string }): void {
    this.db
      .prepare("INSERT INTO scan_events (scan_id, type, message, created_at) VALUES (?, ?, ?, ?)")
      .run(event.scanId, event.type, event.message, event.createdAt ?? nowIso());
  }

  listEvents(scanId: string): ScanEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM scan_events WHERE scan_id = ? ORDER BY id ASC")
      .all(scanId) as ScanEventRow[];
    return rows.map((row) => ({
      id: row.id,
      scanId: row.scan_id,
      type: row.type as ScanEvent["type"],
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  replaceGraphRows(input: {
    workspaceId: string;
    repositoryId: string;
    scanId: string;
    graph: GraphData;
  }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM evidence WHERE scan_id = ?").run(input.scanId);
      this.db.prepare("DELETE FROM edges WHERE scan_id = ?").run(input.scanId);
      this.db.prepare("DELETE FROM nodes WHERE scan_id = ?").run(input.scanId);

      const now = nowIso();
      const insertNode = this.db.prepare(`
        INSERT INTO nodes
          (id, workspace_id, repository_id, scan_id, stable_id, kind, label, domain, summary, confidence, risks_json, data_json, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEdge = this.db.prepare(`
        INSERT INTO edges
          (id, workspace_id, repository_id, scan_id, stable_id, source_stable_id, target_stable_id, kind, summary, confidence, evidence_json, data_json, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEvidence = this.db.prepare(`
        INSERT INTO evidence
          (scan_id, subject_type, subject_stable_id, stable_id, file_path, line_start, line_end, snippet, detector, confidence_reason, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const node of input.graph.nodes) {
        insertNode.run(
          `${input.scanId}:node:${node.id}`,
          input.workspaceId,
          input.repositoryId,
          input.scanId,
          node.id,
          node.kind,
          node.label,
          node.domain,
          node.whatItIs,
          node.confidence,
          json(node.risks),
          json(node),
          now,
        );
        for (const evidence of node.evidence ?? []) {
          insertEvidence.run(
            input.scanId,
            "node",
            node.id,
            evidence.id ?? null,
            evidence.filePath,
            evidence.lineStart,
            evidence.lineEnd,
            evidence.snippet,
            evidence.detector,
            evidence.confidenceReason,
            now,
          );
        }
      }

      for (const edge of input.graph.links) {
        insertEdge.run(
          `${input.scanId}:edge:${edge.id}`,
          input.workspaceId,
          input.repositoryId,
          input.scanId,
          edge.id,
          edge.source,
          edge.target,
          edge.kind,
          edge.summary,
          edge.confidence,
          json(edge.evidence ?? []),
          json(edge),
          now,
        );
        for (const evidence of edge.evidence ?? []) {
          insertEvidence.run(
            input.scanId,
            "edge",
            edge.id,
            evidence.id ?? null,
            evidence.filePath,
            evidence.lineStart,
            evidence.lineEnd,
            evidence.snippet,
            evidence.detector,
            evidence.confidenceReason,
            now,
          );
        }
      }
    });
    tx();
  }

  getNode(nodeId: string): GraphNode | null {
    const row = this.db
      .prepare("SELECT data_json FROM nodes WHERE stable_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(nodeId) as { data_json: string } | undefined;
    return row ? parseJson<GraphNode | null>(row.data_json, null) : null;
  }

  getEdge(edgeId: string): GraphLink | null {
    const row = this.db
      .prepare("SELECT data_json FROM edges WHERE stable_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(edgeId) as { data_json: string } | undefined;
    return row ? parseJson<GraphLink | null>(row.data_json, null) : null;
  }

  recordBackboard(input: {
    workspaceId: string;
    repositoryId?: string | null;
    scanId?: string | null;
    backboard: BackboardSynthesis;
    requestSummary: string;
  }): void {
    const durableFacts = (input.backboard.durableFacts ?? []).filter(isEvidenceBackedDurableFact);
    this.db
      .prepare(`
        INSERT INTO backboard_records
          (workspace_id, repository_id, scan_id, assistant_id, thread_id, run_id, message_id, memory_mode, memory_operation_id, memory_facts_json, request_summary, response_json, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.workspaceId,
        input.repositoryId ?? null,
        input.scanId ?? null,
        input.backboard.assistantId,
        input.backboard.threadId,
        input.backboard.runId ?? null,
        input.backboard.messageId ?? null,
        input.backboard.memoryMode,
        input.backboard.memoryOperationId ?? null,
        durableFacts.length > 0 ? json(durableFacts) : null,
        input.requestSummary,
        json(input.backboard.responseJson),
        nowIso(),
      );
  }

  createChatSession(input: {
    id: string;
    workspaceId: string;
    title: string;
    assistantId: string;
    threadId?: string | null;
    selectedNodeId?: string | null;
    selectedEdgeId?: string | null;
  }): ChatSessionRecord {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO chat_sessions
          (id, workspace_id, title, assistant_id, thread_id, selected_node_id, selected_edge_id, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.workspaceId,
        input.title,
        input.assistantId,
        input.threadId ?? null,
        input.selectedNodeId ?? null,
        input.selectedEdgeId ?? null,
        now,
        now,
      );
    return this.getChatSession(input.id)!;
  }

  getChatSession(sessionId: string): ChatSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(sessionId) as ChatSessionRow | undefined;
    return row ? chatSessionFromRow(row) : null;
  }

  updateChatSessionThread(sessionId: string, threadId: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET thread_id = ?, updated_at = ? WHERE id = ?")
      .run(threadId, nowIso(), sessionId);
  }

  updateChatSessionSelection(sessionId: string, selection: { selectedNodeId?: string | null; selectedEdgeId?: string | null }): void {
    const current = this.getChatSession(sessionId);
    if (!current) return;
    const selectedNodeId = Object.prototype.hasOwnProperty.call(selection, "selectedNodeId")
      ? selection.selectedNodeId ?? null
      : current.selectedNodeId ?? null;
    const selectedEdgeId = Object.prototype.hasOwnProperty.call(selection, "selectedEdgeId")
      ? selection.selectedEdgeId ?? null
      : current.selectedEdgeId ?? null;
    this.db
      .prepare("UPDATE chat_sessions SET selected_node_id = ?, selected_edge_id = ?, updated_at = ? WHERE id = ?")
      .run(selectedNodeId, selectedEdgeId, nowIso(), sessionId);
  }

  addChatMessage(input: {
    id: string;
    sessionId: string;
    role: ChatRole;
    content: string;
    context?: ChatContextBundle | null;
    citations?: ChatCitation[];
    backboardRunId?: string | null;
    backboardMessageId?: string | null;
    memoryOperationId?: string | null;
    memoryError?: string | null;
  }): ChatMessageRecord {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO chat_messages
          (id, session_id, role, content, context_json, citations_json, backboard_run_id, backboard_message_id, memory_operation_id, memory_error, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.sessionId,
        input.role,
        input.content,
        input.context ? json(input.context) : null,
        json(input.citations ?? []),
        input.backboardRunId ?? null,
        input.backboardMessageId ?? null,
        input.memoryOperationId ?? null,
        input.memoryError ?? null,
        now,
      );
    this.db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
    return this.getChatMessage(input.id)!;
  }

  getChatMessage(messageId: string): ChatMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as ChatMessageRow | undefined;
    return row ? chatMessageFromRow(row) : null;
  }

  updateChatMessageMemoryOperation(messageId: string, memoryOperationId: string): ChatMessageRecord | null {
    this.db
      .prepare("UPDATE chat_messages SET memory_operation_id = ?, memory_error = NULL WHERE id = ?")
      .run(memoryOperationId, messageId);
    return this.getChatMessage(messageId);
  }

  listChatMessages(sessionId: string, limit = 80): ChatMessageRecord[] {
    const rows = this.db
      .prepare(`
        SELECT *
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(sessionId, limit) as ChatMessageRow[];
    return rows.reverse().map(chatMessageFromRow);
  }

  listBackboardMemoryFacts(workspaceId: string, limit = 12): string[] {
    const rows = this.db
      .prepare(`
        SELECT memory_operation_id, memory_facts_json
        FROM backboard_records
        WHERE workspace_id = ?
          AND memory_operation_id IS NOT NULL
          AND memory_facts_json IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(workspaceId, limit) as Array<{ memory_operation_id: string | null; memory_facts_json: string | null }>;
    const facts: string[] = [];
    for (const row of rows) {
      const durableFacts = parseJson<DurableMemoryFact[]>(row.memory_facts_json, []).filter(isEvidenceBackedDurableFact);
      for (const fact of durableFacts) {
        const evidence = fact.evidenceIds.slice(0, 4).join(", ");
        const location = fact.evidenceRefs[0]
          ? `${fact.evidenceRefs[0].filePath}:L${fact.evidenceRefs[0].lineStart}`
          : "evidence-indexed scan context";
        facts.push(`${fact.fact} (repo ${fact.repo}; commit ${fact.commitSha}; evidence ${evidence}; ${location}; memory ${row.memory_operation_id})`);
        if (facts.length >= limit) return facts;
      }
    }
    return facts;
  }

  countTable(tableName: string): number {
    const allowed = new Set(["repositories", "scans", "nodes", "edges", "evidence", "backboard_records", "chat_sessions", "chat_messages"]);
    if (!allowed.has(tableName)) throw new Error(`Unsupported table count: ${tableName}`);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count;
  }
}

interface RepositoryRow {
  id: string;
  workspace_id: string;
  owner: string;
  name: string;
  url: string;
  clone_url: string;
  package_name: string | null;
  last_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

interface ScanRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  repo_url: string;
  commit_sha: string | null;
  status: ScanStatus;
  error: string | null;
  graph_json: string | null;
  context_json: string | null;
  backboard_assistant_id: string | null;
  backboard_thread_id: string | null;
  backboard_run_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ScanEventRow {
  id: number;
  scan_id: string;
  type: string;
  message: string;
  created_at: string;
}

interface ChatSessionRow {
  id: string;
  workspace_id: string;
  title: string;
  assistant_id: string;
  thread_id: string | null;
  selected_node_id: string | null;
  selected_edge_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  context_json: string | null;
  citations_json: string;
  backboard_run_id: string | null;
  backboard_message_id: string | null;
  memory_operation_id: string | null;
  memory_error: string | null;
  created_at: string;
}

function repositoryFromRow(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    owner: row.owner,
    name: row.name,
    url: row.url,
    cloneUrl: row.clone_url,
    packageName: row.package_name,
    lastCommitSha: row.last_commit_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatSessionFromRow(row: ChatSessionRow): ChatSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    assistantId: row.assistant_id,
    threadId: row.thread_id,
    selectedNodeId: row.selected_node_id,
    selectedEdgeId: row.selected_edge_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatMessageFromRow(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    context: parseJson<ChatContextBundle | null>(row.context_json, null),
    citations: parseJson<ChatCitation[]>(row.citations_json, []),
    backboardRunId: row.backboard_run_id,
    backboardMessageId: row.backboard_message_id,
    memoryOperationId: row.memory_operation_id,
    memoryError: row.memory_error,
    createdAt: row.created_at,
  };
}

function scanFromRow(row: ScanRow): ScanRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    repoUrl: row.repo_url,
    commitSha: row.commit_sha,
    status: row.status,
    error: row.error,
    graph: parseJson<GraphData | null>(row.graph_json, null),
    context: parseJson<ScanContext | null>(row.context_json, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    backboardAssistantId: row.backboard_assistant_id,
    backboardThreadId: row.backboard_thread_id,
    backboardRunId: row.backboard_run_id,
  };
}
