import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildChatContext, formatCitationList } from "../src/chat/context.js";
import {
  buildChatDurableMemoryFacts,
  buildChatPrompt,
  enforceEvidencePolicy,
  extractDurableMemoryFacts,
} from "../src/backboard/client.js";
import { AtlasRepository, migrate, openDatabase, type SqliteDatabase } from "../src/db/database.js";
import { BackboardClient, buildDurableMemoryFacts } from "../src/backboard/client.js";
import { buildWorkspaceGraph } from "../src/graph/workspace.js";
import { buildHandoffMap, buildScanContext } from "../src/graph/context.js";
import { buildGraphFromArtifacts } from "../src/graph/normalize.js";
import { parseGitHubRepo, repoUrlSchema } from "../src/github/url.js";
import { scanRepository } from "../src/scanner/scanner.js";
import { buildApp } from "../src/server/app.js";
import { ScanService } from "../src/server/scan-service.js";
import { ChatService, type ChatBackboardLike } from "../src/server/chat-service.js";
import type {
  BackboardChatResponse,
  BackboardMemoryStatus,
  BackboardSynthesis,
  ChatContextBundle,
  DurableMemoryFact,
  GraphData,
  RepositoryRecord,
} from "../src/types/domain.js";
import { compactForPrompt, redactSecrets } from "../src/util/redact.js";

const fixtureRoot = path.resolve("tests/fixtures/sample-js");
const FAKE_STRIPE_TOKEN = ["sk", "live", "1234567890", "1234567890", "1234567890"].join("_");
const FAKE_ENV_TOKEN = ["sk", "live", "should_not_be_scanned"].join("_");
const FAKE_PROBE_TOKEN = ["tok", "probe", "1234567890"].join("_");

function fakeBackboard(): BackboardSynthesis {
  return {
    assistantId: "asst_test",
    threadId: "thread_test",
    runId: "run_test",
    messageId: "msg_test",
    content: "{}",
    memoryMode: "Auto",
    memoryOperationId: "mem_test",
    responseJson: { ok: true },
    synthesized: {
      repoPurpose: "Fixture service for scan tests.",
      riskAreas: ["Database and queue paths need runtime verification."],
    },
  };
}

function repoRecord(id = "repo_fixture", packageName = "@atlas/sample-service"): RepositoryRecord {
  return {
    id,
    workspaceId: "test",
    owner: "atlas",
    name: "sample-service",
    url: "https://github.com/atlas/sample-service",
    cloneUrl: "https://github.com/atlas/sample-service.git",
    packageName,
    lastCommitSha: "abc1234",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

async function seedCompletedScan(repository: AtlasRepository): Promise<{ repo: RepositoryRecord; graph: GraphData }> {
  repository.ensureWorkspace("test");
  const repo = repository.upsertRepository({
    id: "repo_fixture",
    workspaceId: "test",
    owner: "atlas",
    name: "sample-service",
    url: "https://github.com/atlas/sample-service",
    cloneUrl: "https://github.com/atlas/sample-service.git",
    packageName: "@atlas/sample-service",
    lastCommitSha: "abc1234",
  });
  const scan = repository.createScan({
    id: "scan_fixture",
    workspaceId: "test",
    repositoryId: repo.id,
    repoUrl: repo.url,
  });
  const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
  const graph = buildGraphFromArtifacts({ repository: repo, commitSha: "abc1234", artifacts, backboard: fakeBackboard() });
  const context = buildScanContext({ repository: repo, graph, commitSha: "abc1234" });
  repository.replaceGraphRows({ workspaceId: "test", repositoryId: repo.id, scanId: scan.id, graph });
  repository.completeScan({ scanId: scan.id, commitSha: "abc1234", graph, context, artifacts, backboard: fakeBackboard() });
  return { repo, graph };
}

describe("repo URL validation", () => {
  it("normalizes supported public GitHub URLs", () => {
    expect(parseGitHubRepo("github.com/fastify/fastify-plugin").normalizedUrl).toBe(
      "https://github.com/fastify/fastify-plugin",
    );
    expect(parseGitHubRepo("https://github.com/fastify/fastify-autoload.git").cloneUrl).toBe(
      "https://github.com/fastify/fastify-autoload.git",
    );
  });

  it("rejects non-GitHub URLs", () => {
    expect(() => repoUrlSchema.parse("https://gitlab.com/a/b")).toThrow();
    expect(() => repoUrlSchema.parse("not-a-repo")).toThrow();
  });
});

describe("deterministic scanner", () => {
  it("extracts package, imports, HTTP, env, database, queue, config, route, and docs clues", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const kinds = new Set(artifacts.findings.map((finding) => finding.kind));

    expect(artifacts.package.name).toBe("@atlas/sample-service");
    for (const kind of ["package", "import", "http", "env", "database", "queue", "config", "api-route", "doc"]) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(artifacts.findings.every((finding) => finding.filePath && finding.lineStart >= 1 && finding.snippet)).toBe(true);
  });

  it("redacts inline secrets and excludes secret files from scan artifacts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-secret-scan-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "@atlas/secret-fixture", dependencies: { axios: "^1.0.0" } }, null, 2));
    await fs.writeFile(
      path.join(tempDir, "src", "client.ts"),
      `const apiKey = "${FAKE_STRIPE_TOKEN}"; axios.post("https://example.com", { apiKey });\n`,
    );
    await fs.writeFile(path.join(tempDir, ".env.local"), `BACKBOARD_API_KEY=${FAKE_ENV_TOKEN}\n`);
    await fs.writeFile(path.join(tempDir, "src", "tokens.ts"), `export const credential = "${FAKE_PROBE_TOKEN}";\n`);

    const artifacts = await scanRepository(tempDir, { maxFiles: 100, maxFileBytes: 100_000 });
    const serialized = JSON.stringify(artifacts);

    expect(redactSecrets(`const apiKey = "${FAKE_STRIPE_TOKEN}";`)).not.toContain(FAKE_STRIPE_TOKEN);
    expect(redactSecrets(`const stripeKey = "${FAKE_PROBE_TOKEN}";`)).not.toContain(FAKE_PROBE_TOKEN);
    expect(redactSecrets(`const credential = "${FAKE_PROBE_TOKEN}";`)).not.toContain(FAKE_PROBE_TOKEN);
    expect(redactSecrets(`const clientSecret = "${FAKE_PROBE_TOKEN}";`)).not.toContain(FAKE_PROBE_TOKEN);
    expect(redactSecrets(`const private_key = "${FAKE_PROBE_TOKEN}";`)).not.toContain(FAKE_PROBE_TOKEN);
    expect(redactSecrets(`const accessToken = "${FAKE_PROBE_TOKEN}";`)).not.toContain(FAKE_PROBE_TOKEN);
    expect(serialized).not.toContain(FAKE_STRIPE_TOKEN);
    expect(serialized).not.toContain(FAKE_PROBE_TOKEN);
    expect(serialized).not.toContain(FAKE_ENV_TOKEN);
    expect(artifacts.files.some((file) => file.path.includes(".env"))).toBe(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe("graph normalization", () => {
  it("builds evidence-backed nodes and edges from scan artifacts", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({
      repository: repoRecord(),
      commitSha: "abc1234",
      artifacts,
      backboard: fakeBackboard(),
    });

    expect(graph.nodes.length).toBeGreaterThan(3);
    expect(graph.links.length).toBeGreaterThan(3);
    expect(graph.nodes.every((node) => (node.evidence?.length ?? 0) > 0)).toBe(true);
    expect(graph.links.every((link) => (link.evidence?.length ?? 0) > 0)).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "database")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "queue")).toBe(true);
  });

  it("keeps unsupported Backboard synthesis out of confirmed graph facts", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({
      repository: repoRecord(),
      commitSha: "abc1234",
      artifacts,
      backboard: {
        ...fakeBackboard(),
        synthesized: {
          repoPurpose: "UNSUPPORTED LLM PURPOSE",
          nodeSummaries: { src: "UNSUPPORTED NODE SUMMARY" },
          edgeSummaries: { axios: "UNSUPPORTED EDGE SUMMARY" },
          riskAreas: ["UNSUPPORTED RISK"],
        },
      },
    });
    const serialized = JSON.stringify(graph);

    expect(serialized).not.toContain("UNSUPPORTED LLM PURPOSE");
    expect(serialized).not.toContain("UNSUPPORTED NODE SUMMARY");
    expect(serialized).not.toContain("UNSUPPORTED EDGE SUMMARY");
    expect(serialized).not.toContain("UNSUPPORTED RISK");
  });

  it("preserves stable evidence ids and source-to-source relative import edges", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({ repository: repoRecord(), commitSha: "abc1234", artifacts, backboard: fakeBackboard() });
    const allEvidence = [...graph.nodes.flatMap((node) => node.evidence ?? []), ...graph.links.flatMap((link) => link.evidence ?? [])];
    const relativeImportLink = graph.links.find((link) => link.contract.startsWith("Relative import path:"));

    expect(allEvidence.every((evidence) => evidence.id)).toBe(true);
    expect(relativeImportLink).toBeTruthy();
    expect(relativeImportLink?.evidence?.[0]?.id).toBeTruthy();
  });

  it("creates relative-import target nodes for otherwise quiet utility files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-relative-import-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "@atlas/relative-fixture" }, null, 2));
    await fs.writeFile(path.join(tempDir, "src", "server.ts"), 'import { helper } from "./helper";\nconsole.log(helper());\n');
    await fs.writeFile(path.join(tempDir, "src", "helper.ts"), "export function helper() { return 1; }\n");

    const artifacts = await scanRepository(tempDir, { maxFiles: 100, maxFileBytes: 100_000 });
    const relativeFindings = artifacts.findings.filter(
      (finding) => finding.kind === "import" && finding.detector === "relative-import",
    );
    const graph = buildGraphFromArtifacts({
      repository: repoRecord("repo_relative", "@atlas/relative-fixture"),
      commitSha: "abc1234",
      artifacts,
      backboard: fakeBackboard(),
    });
    const relativeImportLinks = graph.links.filter((link) => link.contract.startsWith("Relative import path:"));

    expect(relativeFindings).toHaveLength(1);
    expect(relativeImportLinks).toHaveLength(relativeFindings.length);
    expect(graph.nodes.some((node) => node.label === "helper")).toBe(true);
    expect(relativeImportLinks[0].evidence?.[0]?.id).toBe(relativeFindings[0].id);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds a handoff map from evidence files to graph nodes and edges", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const repository = repoRecord();
    const graph = buildGraphFromArtifacts({
      repository,
      commitSha: "abc1234",
      artifacts,
      backboard: fakeBackboard(),
    });
    const handoff = buildHandoffMap({ repository, graph, commitSha: "abc1234" });

    expect(handoff.files.length).toBeGreaterThan(0);
    expect(handoff.files.some((file) => file.filePath === "src/server.ts")).toBe(true);
    expect(handoff.files.flatMap((file) => file.nodes).every((node) => node.confidence && node.detector && node.evidenceId && node.snippet)).toBe(true);
    expect(handoff.files.flatMap((file) => file.edges).every((edge) => edge.confidence && edge.detector && edge.evidenceId && edge.snippet)).toBe(true);
  });
});

describe("SQLite persistence", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let repository: AtlasRepository;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-db-"));
    db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    repository = new AtlasRepository(db);
    repository.ensureWorkspace("test");
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("stores repositories, scans, nodes, edges, evidence, and Backboard records", async () => {
    const repo = repository.upsertRepository({
      id: "repo_fixture",
      workspaceId: "test",
      owner: "atlas",
      name: "sample-service",
      url: "https://github.com/atlas/sample-service",
      cloneUrl: "https://github.com/atlas/sample-service.git",
      packageName: "@atlas/sample-service",
      lastCommitSha: "abc1234",
    });
    const scan = repository.createScan({
      id: "scan_fixture",
      workspaceId: "test",
      repositoryId: repo.id,
      repoUrl: repo.url,
    });
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({ repository: repo, commitSha: "abc1234", artifacts, backboard: fakeBackboard() });
    const context = buildScanContext({ repository: repo, graph, commitSha: "abc1234" });

    repository.replaceGraphRows({ workspaceId: "test", repositoryId: repo.id, scanId: scan.id, graph });
    repository.completeScan({ scanId: scan.id, commitSha: "abc1234", graph, context, artifacts, backboard: fakeBackboard() });
    repository.recordBackboard({
      workspaceId: "test",
      repositoryId: repo.id,
      scanId: scan.id,
      backboard: fakeBackboard(),
      requestSummary: "fixture",
    });

    expect(repository.countTable("repositories")).toBe(1);
    expect(repository.countTable("scans")).toBe(1);
    expect(repository.countTable("nodes")).toBeGreaterThan(0);
    expect(repository.countTable("edges")).toBeGreaterThan(0);
    expect(repository.countTable("evidence")).toBeGreaterThan(0);
    expect(repository.countTable("backboard_records")).toBe(1);
    expect(repository.getNode(graph.nodes[0].id)?.id).toBe(graph.nodes[0].id);
    expect(repository.getEdge(graph.links[0].id)?.id).toBe(graph.links[0].id);
    const evidenceRow = db.prepare("SELECT stable_id FROM evidence WHERE stable_id IS NOT NULL LIMIT 1").get() as
      | { stable_id: string }
      | undefined;
    expect(evidenceRow?.stable_id).toBeTruthy();
  });

  it("indexes only explicit evidence-backed Backboard memory facts, never request summaries", async () => {
    const repo = repository.upsertRepository({
      id: "repo_fixture",
      workspaceId: "test",
      owner: "atlas",
      name: "sample-service",
      url: "https://github.com/atlas/sample-service",
      cloneUrl: "https://github.com/atlas/sample-service.git",
      packageName: "@atlas/sample-service",
      lastCommitSha: "abc1234",
    });
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const durableFacts = buildDurableMemoryFacts({ repository: repo, commitSha: "abc1234", artifacts });

    repository.recordBackboard({
      workspaceId: "test",
      repositoryId: repo.id,
      backboard: {
        ...fakeBackboard(),
        memoryOperationId: "mem_safe",
        durableFacts,
      },
      requestSummary: "chat chat_unsafe: Does payroll-service own customer SSNs?",
    });
    repository.recordBackboard({
      workspaceId: "test",
      repositoryId: repo.id,
      backboard: {
        ...fakeBackboard(),
        memoryOperationId: "mem_prompt_only",
        durableFacts: [],
      },
      requestSummary: "chat chat_prompt_only: Speculative unsupported user prompt",
    });

    const facts = repository.listBackboardMemoryFacts("test");
    const serialized = JSON.stringify(facts);
    expect(facts.length).toBeGreaterThan(0);
    expect(serialized).toContain("evidence");
    expect(serialized).toContain("mem_safe");
    expect(serialized).not.toContain("payroll-service owns customer SSNs");
    expect(serialized).not.toContain("Speculative unsupported user prompt");
  });
});

describe("Backboard payload safety", () => {
  it("builds redacted prompt and evidence-indexed memory facts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-memory-safety-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "@atlas/memory-fixture", dependencies: { axios: "^1.0.0" } }, null, 2));
    await fs.writeFile(
      path.join(tempDir, "src", "client.ts"),
      `const apiKey = "${FAKE_STRIPE_TOKEN}"; axios.post("https://example.com", { apiKey });\n`,
    );
    await fs.writeFile(path.join(tempDir, "src", "tokens.ts"), `export const stripeKey = "${FAKE_PROBE_TOKEN}";\n`);

    const artifacts = await scanRepository(tempDir, { maxFiles: 100, maxFileBytes: 100_000 });
    const promptPayload = compactForPrompt({ findings: artifacts.findings, selectedSnippets: artifacts.selectedSnippets }, 20_000);
    const facts = buildDurableMemoryFacts({ repository: repoRecord("repo_memory", "@atlas/memory-fixture"), commitSha: "abc1234", artifacts });
    const serializedFacts = JSON.stringify(facts);

    expect(promptPayload).not.toContain(FAKE_STRIPE_TOKEN);
    expect(promptPayload).not.toContain(FAKE_PROBE_TOKEN);
    expect(serializedFacts).not.toContain(FAKE_STRIPE_TOKEN);
    expect(serializedFacts).not.toContain(FAKE_PROBE_TOKEN);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((fact) => fact.evidenceIds.length > 0 && fact.evidenceRefs.length > 0)).toBe(true);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("disables Backboard memory on advisory synthesis requests", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const requestBodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (url.endsWith("/threads/messages")) {
        return new Response(JSON.stringify({ thread_id: "thread_test", run_id: "run_test", content: "{}" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/assistants/asst_test/memories")) {
        return new Response(JSON.stringify({ id: "mem_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new BackboardClient(
        loadConfig({
          backboardApiKey: "test-key",
          backboardApiBase: "https://backboard.test",
          backboardMemoryMode: "Auto",
        }),
      );
      await client.synthesizeScan({
        assistantId: "asst_test",
        repository: repoRecord(),
        commitSha: "abc1234",
        artifacts,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBodies[0].memory).toBe("Off");
    expect(String(requestBodies[1].content)).toContain("evidence-indexed facts");
  });

  it("treats scan memory writes without an operation id as auditable failures", async () => {
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/threads/messages")) {
        return new Response(JSON.stringify({ thread_id: "thread_test", run_id: "run_test", content: "{}" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/assistants/asst_test/memories")) {
        return new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new BackboardClient(
        loadConfig({
          backboardApiKey: "test-key",
          backboardApiBase: "https://backboard.test",
          backboardMemoryMode: "Auto",
        }),
      );
      const result = await client.synthesizeScan({
        assistantId: "asst_test",
        repository: repoRecord(),
        commitSha: "abc1234",
        artifacts,
      });

      expect(result.memoryStatus?.attempted).toBe(true);
      expect(result.memoryStatus?.succeeded).toBe(false);
      expect(result.memoryStatus?.operationId).toBeNull();
      expect(result.memoryStatus?.error).toMatch(/memory operation id/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("handoff chat backend", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let repository: AtlasRepository;

  class RecordingBackboard implements ChatBackboardLike {
    createCalls = 0;
    chatCalls: Array<{
      assistantId: string;
      threadId?: string | null;
      sessionId: string;
      workspaceId: string;
      question: string;
      context: ChatContextBundle;
    }> = [];

    async createAssistant(): Promise<string> {
      this.createCalls += 1;
      return "asst_handoff";
    }

    async chat(args: {
      assistantId: string;
      threadId?: string | null;
      sessionId: string;
      workspaceId: string;
      question: string;
      context: ChatContextBundle;
    }): Promise<BackboardChatResponse> {
      this.chatCalls.push(args);
      const citation = args.context.evidence[0]?.id ?? "E1";
      const node = args.context.nodes[0]?.label ?? "the selected component";
      const content = [
        `Direct answer: a takeover engineer should inspect service ${node} first. [${citation}]`,
        `Supporting evidence: [${citation}]`,
        "Confidence: confirmed",
        `Handoff notes: service ${node} is the next concrete inspection target. [${citation}]`,
      ].join("\n");
      return {
        assistantId: args.assistantId,
        threadId: args.threadId ?? "thread_handoff",
        runId: "run_handoff",
        messageId: "msg_handoff",
        content,
        memoryMode: "Auto",
        memoryOperationId: "mem_handoff",
        durableFacts: buildChatDurableMemoryFacts({
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          content,
          context: args.context,
        }),
        responseJson: { ok: true },
      };
    }

    async syncChatMemory(): Promise<BackboardMemoryStatus> {
      return { attempted: true, succeeded: true, operationId: "mem_sync", factCount: 1 };
    }
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-chat-"));
    db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    repository = new AtlasRepository(db);
    await seedCompletedScan(repository);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates chat sessions, reuses the workspace assistant, and stores handoff answers", async () => {
    const backboard = new RecordingBackboard();
    const service = new ChatService(
      loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
      }),
      repository,
      backboard,
    );

    const first = await service.createSession({});
    const second = await service.createSession({});
    expect(first.assistantId).toBe("asst_handoff");
    expect(second.assistantId).toBe("asst_handoff");
    expect(backboard.createCalls).toBe(1);

    const result = await service.sendMessage(first.id, {
      content: "What should a new developer know before taking over this repo?",
      scanId: "scan_fixture",
    });

    expect(result.assistantMessage.content).toContain("takeover engineer");
    expect(result.assistantMessage.citations.length).toBeGreaterThan(0);
    expect(result.session.threadId).toBe("thread_handoff");
    expect(repository.countTable("chat_sessions")).toBe(2);
    expect(repository.countTable("chat_messages")).toBe(2);
    expect(repository.countTable("backboard_records")).toBeGreaterThan(0);
  });

  it("retrieves selected graph context and formats evidence citations", () => {
    const graph = repository.getScan("scan_fixture")!.graph!;
    const selectedNode = graph.nodes.find((node) => node.kind === "database") ?? graph.nodes[0];
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What should I inspect before changing database handoff work?",
      nodeId: selectedNode.id,
    });

    expect(context.nodes.some((node) => node.id === selectedNode.id)).toBe(true);
    expect(context.evidence.length).toBeGreaterThan(0);
    expect(context.evidence[0].stableId).toBeTruthy();
    expect(context.evidence[0].commitSha).toBe("abc1234");
    expect(context.generatedMarkdown).toContain("Evidence Citations");
    expect(formatCitationList(context.evidence)).toContain("[E1]");
  });

  it("constructs Backboard handoff prompts with secrets redacted", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "Before I change this module, what should I verify?",
      scanId: "scan_fixture",
    });
    const rawSecret = "sk_test_123456789012345678901234567890123456";
    const prompt = buildChatPrompt({
      question: `handoff with API_KEY=${rawSecret}`,
      context: {
        ...context,
        generatedMarkdown: `${context.generatedMarkdown}\nTOKEN=${rawSecret}`,
      },
      maxChars: 100_000,
    });

    expect(prompt).toContain("codebase handoff assistant");
    expect(prompt).not.toContain(rawSecret);
    expect(prompt).toContain("[REDACTED]");
  });

  it("does not inject speculative user prompts as known Backboard memory facts", () => {
    repository.recordBackboard({
      workspaceId: "test",
      backboard: {
        ...fakeBackboard(),
        memoryOperationId: "mem_prompt_only",
        durableFacts: [],
      },
      requestSummary: "chat chat_speculative: Does payroll-service own customer SSNs?",
    });

    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What known facts should a handoff reuse?",
      scanId: "scan_fixture",
    });

    expect(JSON.stringify(context.memoryFacts)).not.toContain("payroll-service");
    expect(context.generatedMarkdown).not.toContain("payroll-service");
    expect(context.generatedMarkdown).toContain("No stored memory facts are locally indexed yet");
  });

  it("injects evidence-backed chat memory facts into future handoff context", async () => {
    const backboard = new RecordingBackboard();
    const service = new ChatService(
      loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
      }),
      repository,
      backboard,
    );
    const session = await service.createSession({});
    await service.sendMessage(session.id, {
      content: "What should a new developer inspect before taking over this repo?",
      scanId: "scan_fixture",
    });

    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What known handoff facts can I reuse?",
      scanId: "scan_fixture",
    });

    expect(context.memoryFacts.some((fact) => fact.includes("Handoff notes") || fact.includes("takeover engineer"))).toBe(true);
    expect(context.memoryFacts.every((fact) => fact.includes("evidence") && fact.includes("mem_handoff"))).toBe(true);
    expect(context.generatedMarkdown).toContain("Known Backboard Memory Facts");
  });

  it("extracts only evidence-backed durable handoff memory facts", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What handoff risk matters?",
      scanId: "scan_fixture",
    });
    const facts = extractDurableMemoryFacts(
      [
        "- service queue-eventing is a handoff risk to inspect. [E1]",
        "- maybe there is a hidden owner with no evidence.",
        "- uncertain: the payment path may call a private API. [E2]",
      ].join("\n"),
      context,
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain("queue-eventing");
  });

  it("does not create durable memory facts from uncited answers or unknown citations", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What handoff risk matters?",
      scanId: "scan_fixture",
    });

    expect(extractDurableMemoryFacts("The database module is risky for handoff.", context)).toHaveLength(0);
    expect(extractDurableMemoryFacts("The database module is risky for handoff. [E999]", context)).toHaveLength(0);
    expect(
      buildChatDurableMemoryFacts({
        workspaceId: "test",
        sessionId: "chat_test",
        content: "The database module is risky for handoff.",
        context,
      }),
    ).toHaveLength(0);
  });

  it("marks missing evidence answers uncertain instead of hallucinating", () => {
    const context: ChatContextBundle = {
      workspaceId: "test",
      question: "Who owns the unreleased migration?",
      graphSummary: { repositories: 0, scans: 0, nodes: 0, edges: 0, crossRepoConnections: 0 },
      repositories: [],
      selected: { type: "workspace", id: "test" },
      nodes: [],
      edges: [],
      evidence: [],
      generatedMarkdown: "No matching context.",
      previousMessages: [],
      memoryFacts: [],
      weakEvidence: true,
    };

    const answer = enforceEvidencePolicy("The migration owner is the platform team.", context);
    expect(answer).toContain("I do not have evidence for that in the scanned repos yet.");
    expect(answer).toContain("uncertain");
  });

  it("drops unsupported factual claims in no-evidence contexts even if the refusal sentence is present", () => {
    const context: ChatContextBundle = {
      workspaceId: "test",
      question: "Who owns sensitive payroll data?",
      graphSummary: { repositories: 0, scans: 0, nodes: 0, edges: 0, crossRepoConnections: 0 },
      repositories: [],
      selected: { type: "workspace", id: "test" },
      nodes: [],
      edges: [],
      evidence: [],
      generatedMarkdown: "No matching context.",
      previousMessages: [],
      memoryFacts: [],
      weakEvidence: true,
    };

    const answer = enforceEvidencePolicy(
      "Direct answer: payroll-service owns customer SSNs.\n\nI do not have evidence for that in the scanned repos yet.",
      context,
    );

    expect(answer).toContain("I do not have evidence for that in the scanned repos yet.");
    expect(answer).toContain("unsupported architecture claims in the model output were ignored");
    expect(answer).not.toContain("payroll-service owns customer SSNs");
    expect(answer).not.toContain("Direct answer:");
  });

  it("marks uncited Backboard answers as ungrounded instead of attaching supporting citations", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What should I know before changing this module?",
      scanId: "scan_fixture",
    });

    const answer = enforceEvidencePolicy("The database module is the safest first change.", context);

    expect(answer).toContain("did not cite a valid evidence ID");
    expect(answer).toContain("not supporting proof");
    expect(answer).not.toContain("Supporting evidence:");
    expect(extractDurableMemoryFacts(answer, context)).toHaveLength(0);
  });

  it("marks answers with only unknown citations as unverified", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "Is the database module safe?",
      scanId: "scan_fixture",
    });

    const answer = enforceEvidencePolicy("The database module is safe. [E999]", context);

    expect(answer).toContain("Confidence: uncertain");
    expect(answer).toContain("Invalid citations ignored: [E999]");
    expect(answer).toContain("not supporting proof");
    expect(answer).not.toContain("database module is safe");
    expect(answer).not.toContain("confirmed by retrieved scan evidence");
    expect(extractDurableMemoryFacts(answer, context)).toHaveLength(0);
  });

  it("does not preserve confident unsupported direct answers when only citations are unknown", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "Who owns SSNs?",
      scanId: "scan_fixture",
    });

    const answer = enforceEvidencePolicy("Direct answer: payroll-service is confirmed as the SSN owner. [E999]", context);

    expect(answer).toContain("Direct answer: I cannot verify that claim from the retrieved scan evidence.");
    expect(answer).toContain("Invalid citations ignored: [E999]");
    expect(answer).toContain("unsupported architecture claims in the model output were ignored");
    expect(answer).not.toContain("payroll-service is confirmed as the SSN owner");
    expect(answer).not.toContain("is confirmed");
    expect(answer).not.toContain("SSN owner");
    expect(answer).not.toContain("grounded");
    expect(extractDurableMemoryFacts(answer, context)).toHaveLength(0);
  });

  it("removes preexisting confirmed confidence when only unknown citations are present", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "Is the database module safe?",
      scanId: "scan_fixture",
    });

    const answer = enforceEvidencePolicy(
      "The database module is safe. [E999]\n\nConfidence: confirmed by retrieved scan evidence.",
      context,
    );

    expect(answer).toContain("Confidence: uncertain");
    expect(answer).toContain("Invalid citations ignored: [E999]");
    expect(answer).toContain("unverified");
    expect(answer).not.toContain("database module is safe");
    expect(answer).not.toContain("confirmed by retrieved scan evidence");
    expect(answer).not.toContain("grounded");
    expect(extractDurableMemoryFacts(answer, context)).toHaveLength(0);
  });

  it("flags mixed valid and unknown citations without global confirmed confidence", () => {
    const context = buildChatContext({
      repository,
      workspaceId: "test",
      question: "What database risk should a handoff mention?",
      scanId: "scan_fixture",
    });

    const answer = enforceEvidencePolicy("The database module is a handoff risk. [E1] [E999]", context);

    expect(answer).toContain("Citation warning");
    expect(answer).toContain("unknown citations ignored: [E999]");
    expect(answer).toContain("Only known retrieved citations are accepted as evidence: [E1]");
    expect(answer).toContain("partially supported by known scan evidence only");
    expect(answer).not.toContain("confirmed by retrieved scan evidence");
    expect(extractDurableMemoryFacts(answer, context)).toHaveLength(0);
  });

  it("serves the chat API routes with persisted assistant messages", async () => {
    const backboard = new RecordingBackboard();
    const app = await buildApp({
      config: loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
      }),
      repository,
      chatService: new ChatService(
        loadConfig({
          rootDir: tempDir,
          databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
          databasePath: path.join(tempDir, "atlas.db"),
          workspaceId: "test",
          backboardApiKey: "test",
        }),
        repository,
        backboard,
      ),
    });

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/chat/sessions",
      payload: { title: "PR handoff" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json() as { id: string; assistantId: string };
    expect(session.assistantId).toBe("asst_handoff");

    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: {
        content: "What should a new developer inspect before taking over this unfinished PR?",
        scanId: "scan_fixture",
      },
    });
    expect(messageResponse.statusCode).toBe(201);
    expect(messageResponse.json().assistantMessage.content).toContain("Handoff notes");

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/chat/sessions/${session.id}/messages`,
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().messages).toHaveLength(2);

    await app.close();
  });

  it("protects chat API routes when optional API auth is configured", async () => {
    const backboard = new RecordingBackboard();
    const authedConfig = loadConfig({
      rootDir: tempDir,
      databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
      databasePath: path.join(tempDir, "atlas.db"),
      workspaceId: "test",
      backboardApiKey: "test",
      apiAuthToken: "chat-secret",
    });
    const app = await buildApp({
      config: authedConfig,
      repository,
      chatService: new ChatService(authedConfig, repository, backboard),
    });
    const auth = { authorization: "Bearer chat-secret" };

    const missingSession = await app.inject({
      method: "POST",
      url: "/api/chat/sessions",
      payload: { title: "Protected PR handoff" },
    });
    expect(missingSession.statusCode).toBe(401);

    const invalidSession = await app.inject({
      method: "POST",
      url: "/api/chat/sessions",
      headers: { authorization: "Bearer wrong" },
      payload: { title: "Protected PR handoff" },
    });
    expect(invalidSession.statusCode).toBe(401);

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/chat/sessions",
      headers: auth,
      payload: { title: "Protected PR handoff" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json() as { id: string };

    const missingGet = await app.inject({
      method: "GET",
      url: `/api/chat/sessions/${session.id}`,
    });
    expect(missingGet.statusCode).toBe(401);

    const getSession = await app.inject({
      method: "GET",
      url: `/api/chat/sessions/${session.id}`,
      headers: auth,
    });
    expect(getSession.statusCode).toBe(200);

    const missingMessage = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: {
        content: "What should a new developer inspect before taking over?",
        scanId: "scan_fixture",
      },
    });
    expect(missingMessage.statusCode).toBe(401);

    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: auth,
      payload: {
        content: "What should a new developer inspect before taking over?",
        scanId: "scan_fixture",
      },
    });
    expect(messageResponse.statusCode).toBe(201);

    const missingMessages = await app.inject({
      method: "GET",
      url: `/api/chat/sessions/${session.id}/messages`,
    });
    expect(missingMessages.statusCode).toBe(401);

    const listMessages = await app.inject({
      method: "GET",
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: auth,
    });
    expect(listMessages.statusCode).toBe(200);

    const missingMemorySync = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${session.id}/memory-sync`,
    });
    expect(missingMemorySync.statusCode).toBe(401);

    const memorySync = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${session.id}/memory-sync`,
      headers: auth,
    });
    expect(memorySync.statusCode).toBe(202);

    await app.close();
  });
});

describe("workspace graph merge", () => {
  it("creates supported package-level cross-repo edges from normalized scan graphs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-cross-repo-"));
    const sourceRoot = path.join(tempDir, "app");
    const targetRoot = path.join(tempDir, "plugin");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(targetRoot, { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "@atlas/app", dependencies: { "fastify-plugin": "^5.0.0" } }, null, 2),
    );
    await fs.writeFile(path.join(targetRoot, "package.json"), JSON.stringify({ name: "fastify-plugin" }, null, 2));

    const sourceRepo: RepositoryRecord = {
      ...repoRecord("repo_app", "@atlas/app"),
      name: "app",
      url: "https://github.com/atlas/app",
      cloneUrl: "https://github.com/atlas/app.git",
    };
    const packageRepo: RepositoryRecord = {
      ...repoRecord("repo_plugin", "fastify-plugin"),
      owner: "fastify",
      name: "fastify-plugin",
      url: "https://github.com/fastify/fastify-plugin",
      cloneUrl: "https://github.com/fastify/fastify-plugin.git",
    };
    const sourceArtifacts = await scanRepository(sourceRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const targetArtifacts = await scanRepository(targetRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graphA = buildGraphFromArtifacts({ repository: sourceRepo, commitSha: "a", artifacts: sourceArtifacts });
    const graphB = buildGraphFromArtifacts({ repository: packageRepo, commitSha: "b", artifacts: targetArtifacts });

    const workspace = buildWorkspaceGraph({
      workspaceId: "test",
      repositories: [sourceRepo, packageRepo],
      scans: [
        { id: "scan_a", workspaceId: "test", repositoryId: sourceRepo.id, repoUrl: sourceRepo.url, status: "completed", graph: graphA, createdAt: "", commitSha: "a" },
        { id: "scan_b", workspaceId: "test", repositoryId: packageRepo.id, repoUrl: packageRepo.url, status: "completed", graph: graphB, createdAt: "", commitSha: "b" },
      ],
    });

    expect(workspace.crossRepoConnections).toHaveLength(1);
    expect(workspace.nodes).toHaveLength(2);
    expect(workspace.nodes.every((node) => node.domain === "System")).toBe(true);
    expect(workspace.crossRepoConnections[0].sourceEvidence.every((item) => item.detector === "package-json-dependency")).toBe(true);
    expect(workspace.crossRepoConnections[0].targetEvidence.every((item) => item.detector === "package-json-name")).toBe(true);
    const crossRepoLink = workspace.links.find((link) => link.contract.includes("Relationship type: Package consumer -> package producer"));
    expect(crossRepoLink).toBeDefined();
    expect(crossRepoLink?.summary).toContain("package-level code dependency");
    expect(crossRepoLink?.contract).toContain("Consumer repo: atlas/app");
    expect(crossRepoLink?.contract).toContain("Producer repo: fastify/fastify-plugin");
    expect(crossRepoLink?.beforeYouChange).toContain("fastify-plugin@^5.0.0");
    expect(crossRepoLink?.kind).toBe("package");
    expect(workspace.nodes.some((node) => node.id === crossRepoLink?.source)).toBe(true);
    expect(workspace.nodes.some((node) => node.id === crossRepoLink?.target)).toBe(true);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not emit cross-repo produced-by edges without direct target package-name evidence", () => {
    const sourceRepo = repoRecord("repo_app", "@atlas/app");
    const targetRepo = repoRecord("repo_target", "fastify-plugin");
    const graphA: GraphData = {
      nodes: [
        { id: "app-root", label: "atlas/sample-service", kind: "service", domain: "Repository", whatItIs: "app", whyItExists: "test", owns: [], confidence: "confirmed", risks: [], repositoryId: sourceRepo.id, evidence: [] },
        { id: "dep-fastify-plugin", label: "fastify-plugin", kind: "external", domain: "Dependency", whatItIs: "dep", whyItExists: "test", owns: [], confidence: "confirmed", risks: [], repositoryId: sourceRepo.id, evidence: [] },
      ],
      links: [
        {
          id: "app-fastify-plugin",
          source: "app-root",
          target: "dep-fastify-plugin",
          kind: "sync",
          criticality: 3,
          summary: "depends",
          code: "\"fastify-plugin\": \"^5.0.0\"",
          codePath: "package.json:L4",
          contract: "package.json dependency fastify-plugin@^5.0.0",
          failure: "test",
          risks: [],
          confidence: "confirmed",
          repositoryId: sourceRepo.id,
          evidence: [{ id: "ev-source-dep", filePath: "package.json", lineStart: 4, lineEnd: 4, snippet: "\"fastify-plugin\": \"^5.0.0\"", detector: "package-json-dependency", confidenceReason: "test" }],
        },
      ],
    };
    const graphB: GraphData = {
      nodes: [
        { id: "target-root", label: "atlas/sample-service", kind: "service", domain: "Repository", whatItIs: "target", whyItExists: "test", owns: [], confidence: "confirmed", risks: [], repositoryId: targetRepo.id, evidence: [{ id: "ev-generic", filePath: "package.json", lineStart: 1, lineEnd: 1, snippet: "{}", detector: "config-file", confidenceReason: "generic config" }] },
      ],
      links: [],
    };

    const workspace = buildWorkspaceGraph({
      workspaceId: "test",
      repositories: [sourceRepo, targetRepo],
      scans: [
        { id: "scan_a", workspaceId: "test", repositoryId: sourceRepo.id, repoUrl: sourceRepo.url, status: "completed", graph: graphA, createdAt: "", commitSha: "a" },
        { id: "scan_b", workspaceId: "test", repositoryId: targetRepo.id, repoUrl: targetRepo.url, status: "completed", graph: graphB, createdAt: "", commitSha: "b" },
      ],
    });

    expect(workspace.crossRepoConnections).toHaveLength(0);
    expect(workspace.nodes).toHaveLength(2);
    expect(workspace.nodes.every((node) => node.domain === "System")).toBe(true);
    expect(workspace.links.some((link) => link.contract.includes("Relationship type: Package consumer -> package producer"))).toBe(false);
  });
});

describe("API route schemas", () => {
  it("enforces optional API auth on scan and export endpoints", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-api-auth-"));
    const db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    const repository = new AtlasRepository(db);
    repository.ensureWorkspace("test");
    const app = await buildApp({
      config: loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
        apiAuthToken: "local-token",
      }),
      repository,
    });

    const unauthorized = await app.inject({ method: "POST", url: "/api/scans", payload: { repoUrl: "https://github.com/fastify/fastify-plugin" } });
    const authorizedInvalid = await app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { authorization: "Bearer local-token" },
      payload: { repoUrl: "https://gitlab.com/not/github" },
    });
    const exportUnauthorized = await app.inject({ method: "GET", url: "/api/scans/missing/export" });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorizedInvalid.statusCode).toBe(400);
    expect(exportUnauthorized.statusCode).toBe(401);
    await app.close();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("protects all artifact-bearing read endpoints when API auth is configured", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-api-read-auth-"));
    const db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    const repository = new AtlasRepository(db);
    repository.ensureWorkspace("test");
    const repo = repository.upsertRepository({
      id: "repo_auth",
      workspaceId: "test",
      owner: "atlas",
      name: "auth-fixture",
      url: "https://github.com/atlas/auth-fixture",
      cloneUrl: "https://github.com/atlas/auth-fixture.git",
      packageName: "@atlas/sample-service",
      lastCommitSha: "abc1234",
    });
    const scan = repository.createScan({ id: "scan_auth", workspaceId: "test", repositoryId: repo.id, repoUrl: repo.url });
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({ repository: repo, commitSha: "abc1234", artifacts, backboard: fakeBackboard() });
    const context = buildScanContext({ repository: repo, graph, commitSha: "abc1234" });
    repository.addEvent({ scanId: scan.id, type: "scan", message: "fixture event" });
    repository.replaceGraphRows({ workspaceId: "test", repositoryId: repo.id, scanId: scan.id, graph });
    repository.completeScan({ scanId: scan.id, commitSha: "abc1234", graph, context, artifacts, backboard: fakeBackboard() });

    const app = await buildApp({
      config: loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
        apiAuthToken: "local-token",
      }),
      repository,
    });

    const endpoints = [
      `/api/scans/${scan.id}`,
      `/api/scans/${scan.id}/events`,
      `/api/scans/${scan.id}/graph`,
      `/api/scans/${scan.id}/context`,
      `/api/scans/${scan.id}/handoff`,
      `/api/scans/${scan.id}/export`,
      "/api/workspaces/test/graph",
      "/api/repositories?workspaceId=test",
      `/api/nodes/${encodeURIComponent(graph.nodes[0].id)}`,
      `/api/edges/${encodeURIComponent(graph.links[0].id)}`,
    ];

    for (const url of endpoints) {
      const withoutAuth = await app.inject({ method: "GET", url });
      const withAuth = await app.inject({ method: "GET", url, headers: { authorization: "Bearer local-token" } });
      expect(withoutAuth.statusCode, url).toBe(401);
      expect(withAuth.statusCode, url).toBe(200);
    }

    await app.close();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("enforces configured GitHub allowed owners before cloning", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-allowed-orgs-"));
    const db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    const repository = new AtlasRepository(db);
    const service = new ScanService(
      loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
        githubAllowedOrgs: ["fastify"],
      }),
      repository,
    );

    await expect(service.startScan({ repoUrl: "https://github.com/not-fastify/example" })).rejects.toThrow(
      /not allowed/,
    );
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns 400 for invalid scan requests", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-api-"));
    const db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    const repository = new AtlasRepository(db);
    repository.ensureWorkspace("test");
    const app = await buildApp({
      config: loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
      }),
      repository,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/scans",
      payload: { repoUrl: "https://gitlab.com/not/github" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns the handoff map for completed scans", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-api-"));
    const db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    const repository = new AtlasRepository(db);
    repository.ensureWorkspace("test");
    const repo = repository.upsertRepository({
      id: "repo_fixture",
      workspaceId: "test",
      owner: "atlas",
      name: "sample-service",
      url: "https://github.com/atlas/sample-service",
      cloneUrl: "https://github.com/atlas/sample-service.git",
      packageName: "@atlas/sample-service",
      lastCommitSha: "abc1234",
    });
    const scan = repository.createScan({
      id: "scan_fixture",
      workspaceId: "test",
      repositoryId: repo.id,
      repoUrl: repo.url,
    });
    const artifacts = await scanRepository(fixtureRoot, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({ repository: repo, commitSha: "abc1234", artifacts, backboard: fakeBackboard() });
    const context = buildScanContext({ repository: repo, graph, commitSha: "abc1234" });
    repository.replaceGraphRows({ workspaceId: "test", repositoryId: repo.id, scanId: scan.id, graph });
    repository.completeScan({ scanId: scan.id, commitSha: "abc1234", graph, context, artifacts, backboard: fakeBackboard() });
    const app = await buildApp({
      config: loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
      }),
      repository,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/scans/scan_fixture/handoff",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.commitSha).toBe("abc1234");
    expect(body.files.length).toBeGreaterThan(0);
    await app.close();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("exports handoff map and sanitized snippets for completed scans", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-api-export-"));
    const fixtureDir = path.join(tempDir, "fixture");
    await fs.mkdir(path.join(fixtureDir, "src"), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, "package.json"), JSON.stringify({ name: "@atlas/export-fixture", dependencies: { axios: "^1.0.0" } }, null, 2));
    await fs.writeFile(
      path.join(fixtureDir, "src", "client.ts"),
      `const apiKey = "${FAKE_STRIPE_TOKEN}"; axios.post("https://example.com", { apiKey });\n`,
    );
    await fs.writeFile(path.join(fixtureDir, "src", "tokens.ts"), `export const stripeKey = "${FAKE_PROBE_TOKEN}";\n`);
    const db = openDatabase(path.join(tempDir, "atlas.db"));
    migrate(db);
    const repository = new AtlasRepository(db);
    repository.ensureWorkspace("test");
    const repo = repository.upsertRepository({
      id: "repo_export",
      workspaceId: "test",
      owner: "atlas",
      name: "export-fixture",
      url: "https://github.com/atlas/export-fixture",
      cloneUrl: "https://github.com/atlas/export-fixture.git",
      packageName: "@atlas/export-fixture",
      lastCommitSha: "abc1234",
    });
    const scan = repository.createScan({ id: "scan_export", workspaceId: "test", repositoryId: repo.id, repoUrl: repo.url });
    const artifacts = await scanRepository(fixtureDir, { maxFiles: 100, maxFileBytes: 100_000 });
    const graph = buildGraphFromArtifacts({ repository: repo, commitSha: "abc1234", artifacts, backboard: fakeBackboard() });
    const context = buildScanContext({ repository: repo, graph, commitSha: "abc1234", backboard: { assistantId: "asst", threadId: "thread", runId: "run", memoryMode: "Auto", memoryOperationId: "mem", memoryStatus: { attempted: true, succeeded: true, operationId: "mem", factCount: 1 } } });
    repository.replaceGraphRows({ workspaceId: "test", repositoryId: repo.id, scanId: scan.id, graph });
    repository.completeScan({ scanId: scan.id, commitSha: "abc1234", graph, context, artifacts, backboard: fakeBackboard() });
    const app = await buildApp({
      config: loadConfig({
        rootDir: tempDir,
        databaseUrl: `file:${path.join(tempDir, "atlas.db")}`,
        databasePath: path.join(tempDir, "atlas.db"),
        workspaceId: "test",
        backboardApiKey: "test",
      }),
      repository,
    });

    const response = await app.inject({ method: "GET", url: "/api/scans/scan_export/export" });
    const body = JSON.parse(response.body);
    const serialized = JSON.stringify(body);

    expect(response.statusCode).toBe(200);
    expect(body.files.map((file: { path: string }) => file.path)).toContain("handoff/handoff-map.json");
    expect(body.files.map((file: { path: string }) => file.path)).toContain("backboard/backboard-record.json");
    expect(serialized).not.toContain(FAKE_STRIPE_TOKEN);
    expect(serialized).not.toContain(FAKE_PROBE_TOKEN);
    await app.close();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
