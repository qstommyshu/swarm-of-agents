import type { AtlasConfig } from "../config.js";
import type {
  BackboardChatResponse,
  BackboardMemoryStatus,
  BackboardSynthesis,
  ChatContextBundle,
  DurableMemoryFact,
  RepositoryRecord,
  ScanArtifacts,
} from "../types/domain.js";
import { compactForPrompt, redactSecrets } from "../util/redact.js";
import { stableId } from "../util/ids.js";

interface BackboardAssistantResponse {
  id?: string;
  assistant_id?: string;
  [key: string]: unknown;
}

interface BackboardMessageResponse {
  id?: string;
  message_id?: string;
  thread_id?: string;
  thread?: { id?: string };
  run_id?: string;
  content?: unknown;
  message?: { content?: unknown; id?: string };
  output?: unknown;
  [key: string]: unknown;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return asText((item as { text: unknown }).text);
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return "";
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

function listFromJson(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function recordFromJson(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export function buildDurableMemoryFacts(args: {
  repository: RepositoryRecord;
  commitSha: string;
  artifacts: ScanArtifacts;
}): DurableMemoryFact[] {
  const repo = `${args.repository.owner}/${args.repository.name}`;
  const facts: DurableMemoryFact[] = [];
  const packageNameFinding = args.artifacts.findings.find(
    (finding) => finding.detector === "package-json-name" && finding.value === args.artifacts.package.name,
  );
  if (args.artifacts.package.name && packageNameFinding) {
    facts.push({
      id: stableId("memory-fact", args.repository.id, args.commitSha, "package-name", args.artifacts.package.name),
      scope: "repository",
      repositoryId: args.repository.id,
      repo,
      commitSha: args.commitSha,
      fact: `${repo} declares package identity ${args.artifacts.package.name}.`,
      confidence: "confirmed",
      evidenceIds: [packageNameFinding.id],
      evidenceRefs: [
        {
          evidenceId: packageNameFinding.id,
          filePath: packageNameFinding.filePath,
          lineStart: packageNameFinding.lineStart,
          lineEnd: packageNameFinding.lineEnd,
          detector: packageNameFinding.detector,
          snippet: redactSecrets(packageNameFinding.snippet),
        },
      ],
    });
  }

  for (const finding of args.artifacts.findings.filter((item) => item.kind === "package").slice(0, 40)) {
    if (finding.detector === "package-json-name") continue;
    facts.push({
      id: stableId("memory-fact", args.repository.id, args.commitSha, "dependency", finding.label),
      scope: "dependency",
      repositoryId: args.repository.id,
      repo,
      commitSha: args.commitSha,
      fact: `${repo} declares dependency ${finding.label}.`,
      confidence: "confirmed",
      evidenceIds: [finding.id],
      evidenceRefs: [
        {
          evidenceId: finding.id,
          filePath: finding.filePath,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          detector: finding.detector,
          snippet: redactSecrets(finding.snippet),
        },
      ],
    });
  }

  return facts;
}

export function buildChatDurableMemoryFacts(args: {
  workspaceId: string;
  sessionId: string;
  content: string;
  context: ChatContextBundle;
}): DurableMemoryFact[] {
  const factTexts = extractDurableMemoryFacts(args.content, args.context);
  if (factTexts.length === 0 || args.context.evidence.length === 0) return [];

  const repoById = new Map(args.context.repositories.map((repo) => [repo.id, `${repo.owner}/${repo.name}`]));
  return factTexts.flatMap((factText) => {
    const citedIds = Array.from(factText.matchAll(/\[(E\d+)\]/g)).map((match) => match[1]);
    if (citedIds.length === 0) return [];
    const citations = args.context.evidence.filter((citation) => citedIds.includes(citation.id));
    const validCitations = citations.filter((citation) => citation?.filePath && citation.lineStart);
    if (validCitations.length === 0) return [];

    const primary = validCitations[0];
    const repositoryId = primary.repositoryId ?? args.context.repositories[0]?.id ?? args.workspaceId;
    const commitSha = primary.commitSha ?? "unknown";
    return [{
      id: stableId("memory-fact", "chat", args.workspaceId, args.sessionId, commitSha, factText),
      scope: "finding",
      repositoryId,
      repo: repoById.get(repositoryId) ?? `workspace/${args.workspaceId}`,
      commitSha,
      fact: factText,
      confidence: primary.confidence ?? (args.context.weakEvidence ? "inferred" : "confirmed"),
      evidenceIds: validCitations.map((citation) => citation.stableId ?? citation.id),
      evidenceRefs: validCitations.map((citation) => ({
        evidenceId: citation.stableId ?? citation.id,
        filePath: citation.filePath ?? "unknown",
        lineStart: citation.lineStart ?? 1,
        lineEnd: citation.lineEnd ?? citation.lineStart ?? 1,
        detector: citation.detector ?? "chat-context",
        snippet: redactSecrets(citation.snippet ?? "").slice(0, 700),
      })),
    }];
  });
}

export class BackboardClient {
  constructor(private readonly config: AtlasConfig) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    if (!this.config.backboardApiKey) {
      throw new Error("BACKBOARD_API_KEY is required for real Backboard scans");
    }

    const response = await fetch(`${this.config.backboardApiBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.backboardApiKey}`,
        "X-API-Key": this.config.backboardApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `Backboard API returned ${response.status}`;
      throw new Error(message);
    }
    return parsed as T;
  }

  async createAssistant(workspaceId: string): Promise<string> {
    const body: Record<string, unknown> = {
      name: `Atlas workspace ${workspaceId}`,
      system_prompt:
        "You are Atlas' codebase handoff assistant. Help new developers and AI agents take over unfinished work using deterministic scan artifacts as source of truth. Do not invent nodes or edges without evidence. Persist reusable repo, system, and task handoff knowledge in memory.",
      metadata: {
        product: "atlas",
        workspaceId,
      },
    };
    if (this.config.backboardModel) body.model = this.config.backboardModel;

    const response = await this.request<BackboardAssistantResponse>("/assistants", body);
    const assistantId = response.id ?? response.assistant_id;
    if (!assistantId) throw new Error("Backboard assistant creation response did not include an assistant id");
    return assistantId;
  }

  async synthesizeScan(args: {
    assistantId: string;
    repository: RepositoryRecord;
    commitSha: string;
    artifacts: ScanArtifacts;
  }): Promise<BackboardSynthesis> {
    const compactArtifacts = {
      repository: {
        owner: args.repository.owner,
        name: args.repository.name,
        url: args.repository.url,
        commitSha: args.commitSha,
        packageName: args.artifacts.package.name,
      },
      inventory: {
        files: args.artifacts.files.slice(0, 240),
        languageCounts: args.artifacts.languageCounts,
        dependencies: args.artifacts.package.dependencies,
        devDependencies: args.artifacts.package.devDependencies,
      },
      findings: args.artifacts.findings.slice(0, 220).map((finding) => ({
        id: finding.id,
        kind: finding.kind,
        label: finding.label,
        value: finding.value,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        snippet: finding.snippet,
        detector: finding.detector,
        confidenceReason: finding.confidenceReason,
      })),
      selectedSnippets: args.artifacts.selectedSnippets.slice(0, 80),
    };

    const prompt = `Analyze this Atlas repository scan. Return concise JSON with keys: repoPurpose, keyModules, detectedDependencies, riskAreas, nodeSummaries, edgeSummaries, crossRepoConnectionClues. Use only provided evidence. If a claim is unsupported, omit it.

${compactForPrompt(compactArtifacts, this.config.scanMaxPromptChars)}`;

    const response = await this.request<BackboardMessageResponse>("/threads/messages", {
      assistant_id: args.assistantId,
      role: "user",
      content: prompt,
      memory: "Off",
      metadata: {
        product: "atlas",
        repositoryId: args.repository.id,
        repo: `${args.repository.owner}/${args.repository.name}`,
        commitSha: args.commitSha,
      },
    });

    const threadId = response.thread_id;
    if (!threadId) throw new Error("Backboard message response did not include a thread id");
    const content = asText(response.content ?? response.message?.content ?? response.output ?? response);
    const parsed = extractJsonObject(content);
    const durableFacts = buildDurableMemoryFacts(args);
    const memoryStatus = await this.addMemorySafe({
      assistantId: args.assistantId,
      repository: args.repository,
      commitSha: args.commitSha,
      facts: durableFacts,
    });

    return {
      assistantId: args.assistantId,
      threadId,
      runId: response.run_id ?? null,
      messageId: response.message_id ?? response.message?.id ?? response.id ?? null,
      content,
      memoryMode: this.config.backboardMemoryMode,
      memoryOperationId: memoryStatus.operationId ?? null,
      memoryStatus,
      durableFacts,
      responseJson: response,
      synthesized: parsed
        ? {
            repoPurpose: typeof parsed.repoPurpose === "string" ? parsed.repoPurpose : undefined,
            keyModules: listFromJson(parsed.keyModules),
            detectedDependencies: listFromJson(parsed.detectedDependencies),
            riskAreas: listFromJson(parsed.riskAreas),
            nodeSummaries: recordFromJson(parsed.nodeSummaries),
            edgeSummaries: recordFromJson(parsed.edgeSummaries),
            crossRepoConnectionClues: listFromJson(parsed.crossRepoConnectionClues),
          }
        : undefined,
    };
  }

  async chat(args: {
    assistantId: string;
    threadId?: string | null;
    sessionId: string;
    workspaceId: string;
    question: string;
    context: ChatContextBundle;
  }): Promise<BackboardChatResponse> {
    const prompt = buildChatPrompt({
      question: args.question,
      context: args.context,
      maxChars: this.config.scanMaxPromptChars,
    });

    const body: Record<string, unknown> = {
      assistant_id: args.assistantId,
      role: "user",
      content: prompt,
      memory: this.config.backboardMemoryMode,
      metadata: {
        product: "atlas",
        workspaceId: args.workspaceId,
        chatSessionId: args.sessionId,
        selected: args.context.selected,
      },
    };
    if (args.threadId) body.thread_id = args.threadId;

    const response = await this.request<BackboardMessageResponse>("/threads/messages", body);
    const threadId = response.thread_id ?? (typeof response.thread === "object" && response.thread && "id" in response.thread ? String(response.thread.id) : undefined);
    if (!threadId) throw new Error("Backboard message response did not include a thread id");
    const rawContent = asText(response.content ?? response.message?.content ?? response.output ?? response);
    const content = enforceEvidencePolicy(rawContent, args.context);
    const memory = await this.addChatMemorySafe({
      assistantId: args.assistantId,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      content,
      context: args.context,
    });
    const durableFacts = memory.operationId
      ? buildChatDurableMemoryFacts({
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          content,
          context: args.context,
        })
      : [];

    return {
      assistantId: args.assistantId,
      threadId,
      runId: response.run_id ?? null,
      messageId: response.message_id ?? response.message?.id ?? response.id ?? null,
      content,
      memoryMode: this.config.backboardMemoryMode,
      memoryOperationId: memory.operationId ?? null,
      memoryStatus: memory,
      memoryError: memory.error ?? null,
      durableFacts,
      responseJson: response,
    };
  }

  async syncChatMemory(args: {
    assistantId: string;
    workspaceId: string;
    sessionId: string;
    content: string;
    context: ChatContextBundle;
  }): Promise<BackboardMemoryStatus> {
    return this.addChatMemorySafe(args);
  }

  private async addMemorySafe(args: {
    assistantId: string;
    repository: RepositoryRecord;
    commitSha: string;
    facts: DurableMemoryFact[];
  }): Promise<BackboardMemoryStatus> {
    if (args.facts.length === 0) {
      return { attempted: false, succeeded: false, operationId: null, factCount: 0 };
    }
    try {
      const response = await this.request<Record<string, unknown>>(`/assistants/${args.assistantId}/memories`, {
        content: compactForPrompt(
          {
            purpose:
              "Durable Atlas repo/system knowledge for future human and AI-agent handoff. Store only these evidence-indexed facts; do not infer additional architecture.",
            repository: `${args.repository.owner}/${args.repository.name}`,
            repositoryId: args.repository.id,
            commitSha: args.commitSha,
            facts: args.facts,
          },
          12_000,
        ),
        metadata: {
          product: "atlas",
          repositoryId: args.repository.id,
          repo: `${args.repository.owner}/${args.repository.name}`,
          commitSha: args.commitSha,
          factCount: args.facts.length,
          evidenceIndexed: true,
        },
      });
      const id = response.id ?? response.memory_id ?? response.operation_id;
      if (typeof id !== "string") {
        return {
          attempted: true,
          succeeded: false,
          operationId: null,
          error: "Backboard memory response did not include a memory operation id.",
          factCount: args.facts.length,
        };
      }
      return {
        attempted: true,
        succeeded: true,
        operationId: id,
        factCount: args.facts.length,
      };
    } catch (error) {
      return {
        attempted: true,
        succeeded: false,
        operationId: null,
        error: error instanceof Error ? error.message : "Unknown Backboard memory failure",
        factCount: args.facts.length,
      };
    }
  }

  private async addChatMemorySafe(args: {
    assistantId: string;
    workspaceId: string;
    sessionId: string;
    content: string;
    context: ChatContextBundle;
  }): Promise<BackboardMemoryStatus> {
    const facts = buildChatDurableMemoryFacts(args);
    if (facts.length === 0) {
      return {
        attempted: false,
        succeeded: false,
        operationId: null,
        error: "No evidence-backed durable handoff facts were extracted for memory.",
        factCount: 0,
      };
    }
    try {
      const response = await this.request<Record<string, unknown>>(`/assistants/${args.assistantId}/memories`, {
        content: compactForPrompt(
          {
            purpose:
              "Durable Atlas handoff knowledge for future human and AI-agent takeover. Store only these evidence-indexed facts; do not infer additional architecture.",
            workspaceId: args.workspaceId,
            chatSessionId: args.sessionId,
            facts,
          },
          12_000,
        ),
        metadata: {
          product: "atlas",
          workspaceId: args.workspaceId,
          chatSessionId: args.sessionId,
          factCount: facts.length,
          evidenceIndexed: true,
          evidenceIds: facts.flatMap((fact) => fact.evidenceIds),
          commits: Array.from(new Set(facts.map((fact) => fact.commitSha).filter(Boolean))),
          repositories: Array.from(new Set(facts.map((fact) => fact.repositoryId).filter(Boolean))),
        },
      });
      const id = response.id ?? response.memory_id ?? response.operation_id;
      if (typeof id === "string") {
        return {
          attempted: true,
          succeeded: true,
          operationId: id,
          factCount: facts.length,
        };
      }
      return {
        attempted: true,
        succeeded: false,
        operationId: null,
        error: "Backboard memory response did not include a memory operation id.",
        factCount: facts.length,
      };
    } catch (error) {
      return {
        attempted: true,
        succeeded: false,
        operationId: null,
        error: error instanceof Error ? error.message : "Backboard memory write failed for an evidence-backed handoff fact.",
        factCount: facts.length,
      };
    }
  }
}

export function buildChatPrompt(args: {
  question: string;
  context: ChatContextBundle;
  maxChars: number;
}): string {
  const safeQuestion = redactSecrets(args.question);
  const safeContext = redactSecrets(args.context.generatedMarkdown);
  const compactContext = compactForPrompt(safeContext, args.maxChars);
  return `You are Atlas' evidence-grounded codebase handoff assistant for a scanned workspace.

Your job is to help a new developer or AI agent take over work in a large enterprise codebase, especially after an unfinished PR or partially completed task. Answer the user's handoff question using only the deterministic Atlas context below plus durable Backboard memory for this same assistant. Do not invent services, dependencies, APIs, queues, databases, repositories, owners, task state, or risks.

Architecture and handoff claims must include evidence citations like [E1] that correspond to the Evidence Citations section. If the context has no supporting evidence for the user's question, say exactly: "I do not have evidence for that in the scanned repos yet."

When relevant, use this structure:
- Direct answer
- Supporting evidence
- Confidence
- Handoff notes
- Related nodes/edges to inspect next
- Suggested next drill-down question

If evidence is weak, mark the answer inferred or uncertain and say what a takeover engineer should verify next. Do not mention secrets or raw env values.

Graph summary:
${JSON.stringify(args.context.graphSummary, null, 2)}

Previous chat messages:
${JSON.stringify(args.context.previousMessages, null, 2)}

User question:
${safeQuestion}

${compactContext}`;
}

function neutralizeUnsupportedConfidence(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => {
      if (!/^\s*Confidence\s*:/i.test(line)) return true;
      return !/(confirmed|grounded|retrieved scan evidence|verified|evidence-backed|supported by)/i.test(line);
    })
    .join("\n")
    .replace(/\bconfirmed by retrieved scan evidence\b/gi, "not verified by retrieved scan evidence")
    .replace(/\bgrounded\b/gi, "not verified")
    .replace(/\bevidence-backed\b/gi, "not verified")
    .trim();
}

export function enforceEvidencePolicy(content: string, context: ChatContextBundle): string {
  let trimmed = content.trim();
  const citedIds = Array.from(trimmed.matchAll(/\[(E\d+)\]/g)).map((match) => match[1]);
  const knownCitationIds = new Set(context.evidence.map((citation) => citation.id));
  const validCitedIds = citedIds.filter((citationId) => knownCitationIds.has(citationId));
  const invalidCitedIds = citedIds.filter((citationId) => !knownCitationIds.has(citationId));
  const hasCitation = citedIds.length > 0;
  const hasValidCitation = validCitedIds.length > 0;
  const hasNoEvidence = trimmed.includes("I do not have evidence for that in the scanned repos yet.");
  if (context.evidence.length === 0) {
    return [
      "I do not have evidence for that in the scanned repos yet.",
      "",
      "Confidence: uncertain. No retrieved scan evidence was available, so unsupported architecture claims in the model output were ignored.",
    ].join("\n");
  }
  if (context.evidence.length > 0 && hasCitation && !hasValidCitation && !hasNoEvidence) {
    const citationIds = context.evidence.slice(0, 3).map((citation) => `[${citation.id}]`).join(" ");
    trimmed = "Direct answer: I cannot verify that claim from the retrieved scan evidence.";
    trimmed = `${trimmed}\n\nConfidence: uncertain and unverified. The answer cited only unknown evidence IDs, so unsupported architecture claims in the model output were ignored.`;
    trimmed = `${trimmed}\n\nRetrieved context to inspect, not supporting proof for the answer: ${citationIds}.`;
    trimmed = `${trimmed}\n\nInvalid citations ignored: ${invalidCitedIds.map((citationId) => `[${citationId}]`).join(" ")}.`;
  } else if (context.evidence.length > 0 && !hasCitation && !hasNoEvidence) {
    const citationIds = context.evidence.slice(0, 3).map((citation) => `[${citation.id}]`).join(" ");
    trimmed = neutralizeUnsupportedConfidence(trimmed);
    trimmed = `${trimmed}\n\nConfidence: uncertain. Retrieved scan context exists, but this answer did not cite a valid evidence ID, so treat architectural claims as unverified.`;
    trimmed = `${trimmed}\n\nRetrieved context to inspect, not supporting proof for the answer: ${citationIds}.`;
  } else if (context.evidence.length > 0 && invalidCitedIds.length > 0 && hasValidCitation && !hasNoEvidence) {
    const invalidList = invalidCitedIds.map((citationId) => `[${citationId}]`).join(" ");
    const validList = validCitedIds.map((citationId) => `[${citationId}]`).join(" ");
    trimmed = neutralizeUnsupportedConfidence(trimmed);
    trimmed = `${trimmed}\n\nCitation warning: unknown citations ignored: ${invalidList}. Only known retrieved citations are accepted as evidence: ${validList}.`;
    if (/\bconfidence\b/i.test(trimmed)) {
      trimmed = `${trimmed}\n\nConfidence correction: partially supported by known scan evidence only; unknown citations are not evidence.`;
    } else {
      trimmed = `${trimmed}\n\nConfidence: partially supported by known scan evidence only; unknown citations are not evidence.`;
    }
  } else if (context.weakEvidence && !/\b(inferred|uncertain|weak evidence)\b/i.test(trimmed)) {
    trimmed = `${trimmed}\n\nConfidence: inferred from limited evidence.`;
  }
  if (context.evidence.length > 0 && hasValidCitation && invalidCitedIds.length === 0 && !/\bconfidence\b/i.test(trimmed)) {
    trimmed = `${trimmed}\n\nConfidence: ${context.weakEvidence ? "inferred from limited evidence" : "confirmed by retrieved scan evidence"}.`;
  }
  const firstCitation = hasValidCitation ? `[${validCitedIds[0]}]` : "";
  if (context.selected?.type === "node" && !/\bRelated nodes\/edges\b/i.test(trimmed)) {
    const node = context.nodes.find((item) => item.id === context.selected?.id);
    if (node) {
      trimmed = `${trimmed}\n\nRelated nodes/edges to inspect next: ${node.label} (${node.kind}) ${firstCitation}.`;
    }
  }
  if (context.selected?.type === "edge" && !/\bRelated nodes\/edges\b/i.test(trimmed)) {
    const edge = context.edges.find((item) => item.id === context.selected?.id);
    if (edge) {
      trimmed = `${trimmed}\n\nRelated nodes/edges to inspect next: ${edge.source} -> ${edge.target} (${edge.kind} connection) ${firstCitation}.`;
    }
  }
  return trimmed;
}

export function extractDurableMemoryFacts(content: string, context: ChatContextBundle): string[] {
  if (context.evidence.length === 0) return [];
  const knownCitationIds = new Set(context.evidence.map((citation) => citation.id));
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  const architectureWords = /(service|module|repo|repository|api|queue|topic|database|db|dependency|depends|calls|imports|edge|connection|risk|before you change|contract)/i;
  const unsupportedWords = /(do not have evidence|uncertain|weak evidence|guess|speculat|no evidence|unsupported|ungrounded|retrieved context|not supporting proof|related nodes\/edges)/i;
  const facts: string[] = [];
  for (const line of lines) {
    if (!architectureWords.test(line)) continue;
    if (unsupportedWords.test(line)) continue;
    const citedIds = Array.from(line.matchAll(/\[(E\d+)\]/g)).map((match) => match[1]);
    if (citedIds.length === 0) continue;
    if (citedIds.some((citationId) => !knownCitationIds.has(citationId))) continue;
    facts.push(redactSecrets(line).slice(0, 700));
    if (facts.length >= 5) break;
  }
  return facts;
}
