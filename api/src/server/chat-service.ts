import type { AtlasConfig } from "../config.js";
import { BackboardClient } from "../backboard/client.js";
import { buildChatContext } from "../chat/context.js";
import type { AtlasRepository } from "../db/database.js";
import type {
  BackboardChatResponse,
  BackboardMemoryStatus,
  ChatContextBundle,
  ChatMessageRecord,
  ChatSessionRecord,
} from "../types/domain.js";
import { newId } from "../util/ids.js";
import { redactSecrets } from "../util/redact.js";

export interface ChatBackboardLike {
  createAssistant(workspaceId: string): Promise<string>;
  chat(args: {
    assistantId: string;
    threadId?: string | null;
    sessionId: string;
    workspaceId: string;
    question: string;
    context: ChatContextBundle;
  }): Promise<BackboardChatResponse>;
  syncChatMemory?(args: {
    assistantId: string;
    workspaceId: string;
    sessionId: string;
    content: string;
    context: ChatContextBundle;
  }): Promise<BackboardMemoryStatus>;
}

export class ChatService {
  private readonly backboard: ChatBackboardLike;

  constructor(
    private readonly config: AtlasConfig,
    private readonly repository: AtlasRepository,
    backboard?: ChatBackboardLike,
  ) {
    this.backboard = backboard ?? new BackboardClient(config);
  }

  async createSession(input: {
    workspaceId?: string;
    title?: string;
    selectedNodeId?: string | null;
    selectedEdgeId?: string | null;
  }): Promise<ChatSessionRecord> {
    const workspaceId = input.workspaceId ?? this.config.workspaceId;
    this.repository.ensureWorkspace(workspaceId);
    const assistantId = await this.ensureAssistant(workspaceId);
    return this.repository.createChatSession({
      id: newId("chat"),
      workspaceId,
      title: input.title?.trim() || "Codebase handoff",
      assistantId,
      selectedNodeId: input.selectedNodeId,
      selectedEdgeId: input.selectedEdgeId,
    });
  }

  getSession(sessionId: string): ChatSessionRecord | null {
    return this.repository.getChatSession(sessionId);
  }

  listMessages(sessionId: string): ChatMessageRecord[] {
    return this.repository.listChatMessages(sessionId);
  }

  async sendMessage(sessionId: string, input: {
    content: string;
    nodeId?: string | null;
    edgeId?: string | null;
    scanId?: string | null;
  }): Promise<{ session: ChatSessionRecord; userMessage: ChatMessageRecord; assistantMessage: ChatMessageRecord }> {
    const session = this.repository.getChatSession(sessionId);
    if (!session) throw Object.assign(new Error("Chat session not found"), { statusCode: 404 });

    const content = redactSecrets(input.content.trim());
    if (!content) throw Object.assign(new Error("Message content is required"), { statusCode: 400 });

    if (input.nodeId || input.edgeId) {
      this.repository.updateChatSessionSelection(sessionId, {
        selectedNodeId: input.nodeId ?? null,
        selectedEdgeId: input.edgeId ?? null,
      });
    }

    const userMessage = this.repository.addChatMessage({
      id: newId("msg"),
      sessionId,
      role: "user",
      content,
      citations: [],
    });

    const messages = this.repository.listChatMessages(sessionId, 16).filter((message) => message.id !== userMessage.id);
    const context = buildChatContext({
      repository: this.repository,
      workspaceId: session.workspaceId,
      question: content,
      sessionMessages: messages,
      nodeId: input.nodeId ?? session.selectedNodeId,
      edgeId: input.edgeId ?? session.selectedEdgeId,
      scanId: input.scanId ?? null,
    });

    const response = await this.backboard.chat({
      assistantId: session.assistantId,
      threadId: session.threadId,
      sessionId,
      workspaceId: session.workspaceId,
      question: content,
      context,
    });

    if (response.threadId !== session.threadId) {
      this.repository.updateChatSessionThread(sessionId, response.threadId);
    }

    this.repository.recordBackboard({
      workspaceId: session.workspaceId,
      backboard: {
        assistantId: response.assistantId,
        threadId: response.threadId,
        runId: response.runId,
        messageId: response.messageId,
        content: response.content,
        memoryMode: response.memoryMode,
        memoryOperationId: response.memoryOperationId,
        durableFacts: response.durableFacts ?? [],
        responseJson: {
          backboard: response.responseJson,
          memoryStatus: response.memoryStatus ?? null,
          memoryError: response.memoryError ?? null,
          durableFacts: response.durableFacts ?? [],
        },
      },
      requestSummary: `chat ${sessionId}: ${content.slice(0, 120)}`,
    });

    const assistantMessage = this.repository.addChatMessage({
      id: newId("msg"),
      sessionId,
      role: "assistant",
      content: response.content,
      context,
      citations: context.evidence,
      backboardRunId: response.runId,
      backboardMessageId: response.messageId,
      memoryOperationId: response.memoryOperationId,
      memoryError: response.memoryError,
    });

    return {
      session: this.repository.getChatSession(sessionId) ?? session,
      userMessage,
      assistantMessage,
    };
  }

  async syncMemory(sessionId: string): Promise<{ session: ChatSessionRecord; message: ChatMessageRecord; memoryOperationId: string | null; memoryError?: string | null }> {
    const session = this.repository.getChatSession(sessionId);
    if (!session) throw Object.assign(new Error("Chat session not found"), { statusCode: 404 });
    const latestAssistantMessage = this.repository
      .listChatMessages(sessionId)
      .filter((message) => message.role === "assistant" && message.context)
      .at(-1);
    if (!latestAssistantMessage?.context) {
      throw Object.assign(new Error("No assistant message with context is available for memory sync"), { statusCode: 409 });
    }
    if (!this.backboard.syncChatMemory) {
      return {
        session,
        message: latestAssistantMessage,
        memoryOperationId: latestAssistantMessage.memoryOperationId ?? null,
        memoryError: latestAssistantMessage.memoryError ?? null,
      };
    }
    const memory = await this.backboard.syncChatMemory({
      assistantId: session.assistantId,
      workspaceId: session.workspaceId,
      sessionId,
      content: latestAssistantMessage.content,
      context: latestAssistantMessage.context,
    });
    const message = memory.operationId
      ? this.repository.updateChatMessageMemoryOperation(latestAssistantMessage.id, memory.operationId) ?? latestAssistantMessage
      : latestAssistantMessage;
    return { session, message, memoryOperationId: memory.operationId ?? null, memoryError: memory.error ?? null };
  }

  private async ensureAssistant(workspaceId: string): Promise<string> {
    const existing = this.repository.getWorkspaceAssistantId(workspaceId);
    if (existing) return existing;
    if (this.config.backboardAssistantId) {
      this.repository.setWorkspaceAssistantId(workspaceId, this.config.backboardAssistantId);
      return this.config.backboardAssistantId;
    }
    const assistantId = await this.backboard.createAssistant(workspaceId);
    this.repository.setWorkspaceAssistantId(workspaceId, assistantId);
    return assistantId;
  }
}
