"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Bot, Loader2, Send, User, X } from "lucide-react";
import {
  createChatSession,
  sendChatMessage,
  type ChatCitation,
  type ChatMessage,
  type ChatSession,
} from "@/lib/api";
import type { GraphLink, GraphNode } from "@/lib/data";
import { ConfidenceBadge, SectionLabel, cn } from "./ui";

const QUICK_PROMPTS = [
  "What does a new developer need to know?",
  "What should I inspect next?",
  "Find handoff risks",
  "Show cross-repo links",
];

function contextLabel(node: GraphNode | null, link: GraphLink | null): string | null {
  if (node) return `Node: ${node.label}`;
  if (link) return `Connection: ${link.source} -> ${link.target}`;
  return null;
}

function fallbackMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Atlas handoff assistant is unavailable.";
  return `Handoff assistant is unavailable: ${message}`;
}

function CitationButton({
  citation,
  onSelectNode,
  onSelectLink,
}: {
  citation: ChatCitation;
  onSelectNode: (id: string) => void;
  onSelectLink: (id: string) => void;
}) {
  const clickable = Boolean(citation.subjectId && (citation.subjectType === "node" || citation.subjectType === "edge"));
  return (
    <button
      type="button"
      data-testid="evidence-link"
      onClick={() => {
        if (!citation.subjectId) return;
        if (citation.subjectType === "node") onSelectNode(citation.subjectId);
        if (citation.subjectType === "edge") onSelectLink(citation.subjectId);
      }}
      disabled={!clickable}
      className={cn(
        "w-full border border-[#2a2a2a] bg-[#0a0a0a] px-2.5 py-2 text-left transition-colors duration-150",
        clickable ? "cursor-pointer hover:border-[#3a3a3a] hover:bg-[#111]" : "cursor-default opacity-80",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-[#ededed]">[{citation.id}]</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[#888]">{citation.label}</span>
        {citation.confidence && <ConfidenceBadge value={citation.confidence} />}
      </div>
      {citation.filePath && (
        <div className="mt-1 truncate font-mono text-[10px] text-[#555]">
          {citation.filePath}:L{citation.lineStart ?? 1}
        </div>
      )}
    </button>
  );
}

function MessageBubble({
  message,
  onSelectNode,
  onSelectLink,
}: {
  message: ChatMessage;
  onSelectNode: (id: string) => void;
  onSelectLink: (id: string) => void;
}) {
  const assistant = message.role === "assistant";
  return (
    <div data-testid={assistant ? "assistant-message" : "user-message"} className="flex gap-2.5">
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border",
          assistant ? "border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#3b82f6]" : "border-[#2a2a2a] bg-[#0a0a0a] text-[#888]",
        )}
      >
        {assistant ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "prose prose-invert max-w-none text-[13px] leading-relaxed prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-strong:text-[#ededed]",
            !assistant && "font-mono text-[#ededed]",
          )}
        >
          {assistant ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          ) : (
            <p>{message.content}</p>
          )}
        </div>
        {assistant && message.citations.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.citations.slice(0, 6).map((citation) => (
              <CitationButton
                key={`${message.id}-${citation.id}-${citation.subjectId ?? ""}`}
                citation={citation}
                onSelectNode={onSelectNode}
                onSelectLink={onSelectLink}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({
  open,
  scanId,
  selectedNode,
  selectedLink,
  detailsOpen = false,
  onClose,
  onSelectNode,
  onSelectLink,
}: {
  open: boolean;
  scanId: string | null;
  selectedNode: GraphNode | null;
  selectedLink: GraphLink | null;
  detailsOpen?: boolean;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  onSelectLink: (id: string) => void;
}) {
  const [session, setSession] = React.useState<ChatSession | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const optimisticIdRef = React.useRef(0);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending, open]);

  async function ensureSession(): Promise<ChatSession> {
    if (session) return session;
    const created = await createChatSession({
      title: "Codebase handoff",
      selectedNodeId: selectedNode?.id ?? null,
      selectedEdgeId: selectedLink?.id ?? null,
    });
    setSession(created);
    return created;
  }

  async function submit(value = input) {
    const content = value.trim();
    if (!content || pending) return;
    setPending(true);
    setError(null);
    optimisticIdRef.current += 1;
    const optimistic: ChatMessage = {
      id: `pending-${optimisticIdRef.current}`,
      sessionId: session?.id ?? "pending",
      role: "user",
      content,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput("");
    try {
      const activeSession = await ensureSession();
      const result = await sendChatMessage(activeSession.id, {
        content,
        nodeId: selectedNode?.id ?? null,
        edgeId: selectedLink?.id ?? null,
        scanId,
      });
      setSession(result.session);
      setMessages((prev) => [
        ...prev.filter((message) => message.id !== optimistic.id),
        result.userMessage,
        result.assistantMessage,
      ]);
    } catch (err) {
      setError(fallbackMessage(err));
      setMessages((prev) => prev.filter((message) => message.id !== optimistic.id));
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;

  const activeContext = contextLabel(selectedNode, selectedLink);
  const selectedPrompt = selectedNode
    ? `What should a new developer know before changing ${selectedNode.label}?`
    : selectedLink
      ? "What is risky about this connection?"
      : null;

  return (
    <aside
      data-testid="chat-panel"
      className={cn(
        "fixed inset-x-3 top-24 z-30 flex flex-col border border-[#2a2a2a] bg-[#050505]/95 backdrop-blur-sm sm:absolute sm:bottom-3 sm:left-3 sm:right-auto sm:top-28 sm:w-[min(430px,calc(100vw-24px))]",
        detailsOpen ? "bottom-[48dvh] sm:bottom-3" : "bottom-3",
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-[#2a2a2a] p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[#3b82f6]" />
            <p className="font-mono text-[13px] font-semibold text-[#ededed]">Handoff assistant</p>
          </div>
          {activeContext && <p className="mt-1 truncate font-mono text-[11px] text-[#555]">{activeContext}</p>}
        </div>
        <button
          type="button"
          aria-label="Close chat"
          onClick={onClose}
          className="cursor-pointer p-1 text-[#555] transition-colors duration-150 hover:text-[#ededed]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="scroll-thin flex-1 space-y-4 overflow-y-auto p-3">
        {messages.length === 0 && !error && (
          <div className="space-y-2">
            <SectionLabel>Takeover questions</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {[...(selectedPrompt ? [selectedPrompt] : []), ...QUICK_PROMPTS].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  data-testid="quick-prompt"
                  onClick={() => void submit(prompt)}
                  className="cursor-pointer border border-[#2a2a2a] bg-[#0a0a0a] px-2.5 py-1.5 text-[12px] text-[#888] transition-colors duration-150 hover:border-[#3a3a3a] hover:text-[#ededed]"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            onSelectNode={onSelectNode}
            onSelectLink={onSelectLink}
          />
        ))}

        {pending && (
          <div className="flex items-center gap-2 font-mono text-[12px] text-[#555]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Building handoff answer
          </div>
        )}

        {error && (
          <div className="flex gap-2 border border-[#ef4444]/30 bg-[#ef4444]/5 p-2.5 text-[12px] leading-relaxed text-[#ef4444]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <form
        className="border-t border-[#2a2a2a] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            data-testid="chat-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask what to inspect, change, or verify next"
            rows={2}
            className="scroll-thin max-h-28 min-h-[42px] flex-1 resize-none border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-[13px] leading-relaxed text-[#ededed] placeholder:text-[#555] focus:border-[#3a3a3a] focus:outline-none"
          />
          <button
            type="submit"
            data-testid="send-chat"
            disabled={pending || input.trim().length === 0}
            className="flex h-[42px] w-10 shrink-0 cursor-pointer items-center justify-center bg-[#ededed] text-black transition-colors duration-150 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Send chat message"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </form>
    </aside>
  );
}
