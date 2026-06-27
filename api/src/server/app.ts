import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { AtlasConfig } from "../config.js";
import { AtlasRepository } from "../db/database.js";
import { buildWorkspaceGraph } from "../graph/workspace.js";
import { repoUrlSchema } from "../github/url.js";
import type { ScanContext } from "../types/domain.js";
import { ChatService } from "./chat-service.js";
import { ScanService } from "./scan-service.js";

const createScanSchema = z.object({
  repoUrl: repoUrlSchema,
  workspaceId: z.string().trim().min(1).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
});

const paramsSchema = z.object({
  scanId: z.string().min(1),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const nodeParamsSchema = z.object({
  nodeId: z.string().min(1),
});

const edgeParamsSchema = z.object({
  edgeId: z.string().min(1),
});

const chatSessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const createChatSessionSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  selectedNodeId: z.string().trim().min(1).nullable().optional(),
  selectedEdgeId: z.string().trim().min(1).nullable().optional(),
});

const createChatMessageSchema = z.object({
  content: z.string().trim().min(1).max(12_000),
  nodeId: z.string().trim().min(1).nullable().optional(),
  edgeId: z.string().trim().min(1).nullable().optional(),
  scanId: z.string().trim().min(1).nullable().optional(),
});

function contextFiles(context: ScanContext) {
  return [
    { path: "system-brief.md", markdown: context.systemBrief },
    ...context.nodeContext.map((file) => ({ path: file.path, markdown: file.markdown })),
    ...context.edgeContext.map((file) => ({ path: file.path, markdown: file.markdown })),
    { path: "handoff/handoff-map.json", markdown: JSON.stringify(context.handoff, null, 2) },
    { path: "backboard/backboard-record.json", markdown: JSON.stringify(context.backboard ?? {}, null, 2) },
  ];
}

export async function buildApp(args: {
  config: AtlasConfig;
  repository: AtlasRepository;
  scanService?: ScanService;
  chatService?: ChatService;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.x-api-key", "BACKBOARD_API_KEY"],
    },
  });

  const scanService = args.scanService ?? new ScanService(args.config, args.repository);
  const chatService = args.chatService ?? new ChatService(args.config, args.repository);

  await app.register(cors, {
    origin: args.config.corsOrigin ?? true,
  });

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!args.config.apiAuthToken) return;
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${args.config.apiAuthToken}`) {
      return reply.status(401).send({ error: "Unauthorized", message: "Missing or invalid API bearer token" });
    }
  };

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error instanceof ZodError ? 400 : error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : "Bad Request",
      message: error.message,
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    database: args.config.databasePath,
    backboardConfigured: Boolean(args.config.backboardApiKey),
  }));

  app.post("/api/scans", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createScanSchema.parse(request.body);
    const scan = await scanService.startScan(parsed);
    reply.status(202).send(scan);
  });

  app.get("/api/scans/:scanId", { preHandler: requireAuth }, async (request, reply) => {
    const { scanId } = paramsSchema.parse(request.params);
    const scan = args.repository.getScan(scanId);
    if (!scan) return reply.status(404).send({ error: "Not Found", message: "Scan not found" });
    return scan;
  });

  app.get("/api/scans/:scanId/events", { preHandler: requireAuth }, async (request, reply) => {
    const { scanId } = paramsSchema.parse(request.params);
    const scan = args.repository.getScan(scanId);
    if (!scan) return reply.status(404).send({ error: "Not Found", message: "Scan not found" });
    return {
      scanId,
      events: args.repository.listEvents(scanId),
    };
  });

  app.get("/api/scans/:scanId/graph", { preHandler: requireAuth }, async (request, reply) => {
    const { scanId } = paramsSchema.parse(request.params);
    const scan = args.repository.getScan(scanId);
    if (!scan) return reply.status(404).send({ error: "Not Found", message: "Scan not found" });
    if (!scan.graph) return reply.status(409).send({ error: "Conflict", message: `Scan is ${scan.status}` });
    return scan.graph;
  });

  app.get("/api/workspaces/:workspaceId/graph", { preHandler: requireAuth }, async (request) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const repositories = args.repository.listRepositories(workspaceId);
    const scans = args.repository.listLatestCompletedScans(workspaceId);
    return buildWorkspaceGraph({ workspaceId, repositories, scans });
  });

  app.get("/api/repositories", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ workspaceId: z.string().optional() }).parse(request.query);
    return {
      repositories: args.repository.listRepositories(query.workspaceId),
    };
  });

  app.get("/api/nodes/:nodeId", { preHandler: requireAuth }, async (request, reply) => {
    const { nodeId } = nodeParamsSchema.parse(request.params);
    const node = args.repository.getNode(nodeId);
    if (!node) return reply.status(404).send({ error: "Not Found", message: "Node not found" });
    return node;
  });

  app.get("/api/edges/:edgeId", { preHandler: requireAuth }, async (request, reply) => {
    const { edgeId } = edgeParamsSchema.parse(request.params);
    const edge = args.repository.getEdge(edgeId);
    if (!edge) return reply.status(404).send({ error: "Not Found", message: "Edge not found" });
    return edge;
  });

  app.get("/api/scans/:scanId/context", { preHandler: requireAuth }, async (request, reply) => {
    const { scanId } = paramsSchema.parse(request.params);
    const scan = args.repository.getScan(scanId);
    if (!scan) return reply.status(404).send({ error: "Not Found", message: "Scan not found" });
    if (!scan.context) return reply.status(409).send({ error: "Conflict", message: `Scan is ${scan.status}` });
    return scan.context;
  });

  app.get("/api/scans/:scanId/handoff", { preHandler: requireAuth }, async (request, reply) => {
    const { scanId } = paramsSchema.parse(request.params);
    const scan = args.repository.getScan(scanId);
    if (!scan) return reply.status(404).send({ error: "Not Found", message: "Scan not found" });
    if (!scan.context) return reply.status(409).send({ error: "Conflict", message: `Scan is ${scan.status}` });
    return scan.context.handoff;
  });

  app.get("/api/scans/:scanId/export", { preHandler: requireAuth }, async (request, reply) => {
    const { scanId } = paramsSchema.parse(request.params);
    const scan = args.repository.getScan(scanId);
    if (!scan) return reply.status(404).send({ error: "Not Found", message: "Scan not found" });
    if (!scan.context) return reply.status(409).send({ error: "Conflict", message: `Scan is ${scan.status}` });
    const files = contextFiles(scan.context);
    return {
      scanId,
      files,
      combinedMarkdown: files.map((file) => `\n\n<!-- ===== ${file.path} ===== -->\n\n${file.markdown}`).join("\n"),
    };
  });

  app.post("/api/chat/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createChatSessionSchema.parse(request.body);
    const session = await chatService.createSession(parsed);
    reply.status(201).send(session);
  });

  app.get("/api/chat/sessions/:sessionId", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = chatSessionParamsSchema.parse(request.params);
    const session = chatService.getSession(sessionId);
    if (!session) return reply.status(404).send({ error: "Not Found", message: "Chat session not found" });
    return session;
  });

  app.get("/api/chat/sessions/:sessionId/messages", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = chatSessionParamsSchema.parse(request.params);
    const session = chatService.getSession(sessionId);
    if (!session) return reply.status(404).send({ error: "Not Found", message: "Chat session not found" });
    return {
      sessionId,
      messages: chatService.listMessages(sessionId),
    };
  });

  app.post("/api/chat/sessions/:sessionId/messages", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = chatSessionParamsSchema.parse(request.params);
    const parsed = createChatMessageSchema.parse(request.body);
    const result = await chatService.sendMessage(sessionId, parsed);
    reply.status(201).send(result);
  });

  app.post("/api/chat/sessions/:sessionId/memory-sync", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = chatSessionParamsSchema.parse(request.params);
    const result = await chatService.syncMemory(sessionId);
    reply.status(202).send(result);
  });

  return app;
}
