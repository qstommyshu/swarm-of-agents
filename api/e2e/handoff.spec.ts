import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiUrl = process.env.ATLAS_E2E_API_URL ?? "http://127.0.0.1:3001";
const workspaceId = process.env.ATLAS_E2E_WORKSPACE_ID ?? "e2e-handoff";
const apiAuthToken = process.env.ATLAS_E2E_API_AUTH_TOKEN ?? "atlas-e2e-local-token";
const authHeaders = { Authorization: `Bearer ${apiAuthToken}` };
const repos = [
  "https://github.com/fastify/fastify-plugin",
  "https://github.com/fastify/fastify-autoload",
];

interface ScanRecord {
  id: string;
  workspaceId: string;
  repoUrl: string;
  status: "queued" | "running" | "completed" | "failed";
  error?: string | null;
  backboardAssistantId?: string | null;
  backboardThreadId?: string | null;
}

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  evidence?: Array<{ filePath: string; lineStart: number; snippet: string }>;
}

interface GraphLink {
  id: string;
  source: string;
  target: string;
  kind: string;
  evidence?: Array<{ filePath: string; lineStart: number; snippet: string }>;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  crossRepoConnections?: unknown[];
}

interface ChatSession {
  id: string;
  assistantId: string;
  threadId?: string | null;
}

interface ChatMessage {
  content: string;
  citations: unknown[];
  memoryOperationId?: string | null;
  memoryError?: string | null;
  backboardRunId?: string | null;
  backboardMessageId?: string | null;
}

let primaryScan: ScanRecord;
let secondaryScan: ScanRecord;
let primaryGraph: GraphData;
let workspaceGraph: GraphData;
let firstSession: ChatSession;
let secondSession: ChatSession;
let firstAssistantMessage: ChatMessage;

test.describe("real Backboard handoff E2E", () => {
test.describe.configure({ mode: "serial" });
test.beforeEach(() => {
  test.skip(!process.env.BACKBOARD_API_KEY, "BACKBOARD_API_KEY is required for real Backboard handoff E2E tests.");
});

async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${apiUrl}${path}`, { headers: authHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function apiPost<T>(request: APIRequestContext, path: string, payload: unknown): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data: payload, headers: authHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function waitForScan(request: APIRequestContext, scanId: string): Promise<ScanRecord> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const scan = await apiGet<ScanRecord>(request, `/api/scans/${encodeURIComponent(scanId)}`);
    if (scan.status === "completed") return scan;
    if (scan.status === "failed") throw new Error(`Scan failed: ${scan.error ?? "unknown error"}`);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error(`Timed out waiting for scan ${scanId}`);
}

async function scanRepo(request: APIRequestContext, repoUrl: string): Promise<ScanRecord> {
  const scan = await apiPost<ScanRecord>(request, "/api/scans", { repoUrl, workspaceId });
  return waitForScan(request, scan.id);
}

async function sendChat(
  request: APIRequestContext,
  sessionId: string,
  payload: { content: string; scanId?: string; nodeId?: string; edgeId?: string },
): Promise<{ session: ChatSession; assistantMessage: ChatMessage }> {
  return apiPost<{ session: ChatSession; assistantMessage: ChatMessage }>(
    request,
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    payload,
  );
}

async function latestAssistantMessage(page: Page) {
  const message = page.getByTestId("assistant-message").last();
  await expect(message).toBeVisible({ timeout: 180_000 });
  await expect(message).toContainText(/Confidence|\[E\d+\]|evidence|I do not have evidence/i, { timeout: 180_000 });
  return message;
}

async function openRealExplore(page: Page) {
  await page.goto(`/explore?scanId=${encodeURIComponent(primaryScan.id)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const realNode = primaryGraph.nodes[0];
  await expect(page.locator(`[data-testid="graph-node"][data-node-id="${realNode.id}"]`)).toBeVisible({ timeout: 60_000 });
}

test("1. backend health initializes SQLite and reports Backboard configuration", async ({ request }) => {
  const health = await apiGet<{ ok: boolean; database: string; backboardConfigured: boolean }>(request, "/api/health");
  expect(health.ok).toBe(true);
  expect(health.database).toContain("atlas-handoff.db");
  expect(health.backboardConfigured).toBe(true);
});

test("2. protected API mode rejects missing or invalid auth for scan and chat routes", async () => {
  const missingScan = await fetch(`${apiUrl}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: repos[0], workspaceId }),
  });
  expect(missingScan.status).toBe(401);

  const invalidChat = await fetch(`${apiUrl}/api/chat/sessions`, {
    method: "POST",
    headers: { Authorization: "Bearer invalid-e2e-token", "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, title: "Invalid auth" }),
  });
  expect(invalidChat.status).toBe(401);
});

test("3. failed real scan submission does not fall back to demo architecture", async ({ page }) => {
  await page.route(`${apiUrl}/api/scans`, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic scan creation failure" }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/github repository url/i).fill("github.com/fastify/fastify-plugin");
  await page.getByRole("button", { name: /visualize/i }).click();

  await expect(page.getByText("Synthetic scan creation failure")).toBeVisible();
  await expect(page.getByTestId("scan-overlay")).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/explore/);
});

test("4. real scan prerequisite returns graph nodes, edges, and evidence", async ({ request }) => {
  test.setTimeout(420_000);
  primaryScan = await scanRepo(request, repos[0]);
  primaryGraph = await apiGet<GraphData>(request, `/api/scans/${encodeURIComponent(primaryScan.id)}/graph`);

  expect(primaryScan.status).toBe("completed");
  expect(primaryScan.backboardAssistantId).toBeTruthy();
  expect(primaryGraph.nodes.length).toBeGreaterThan(0);
  expect(primaryGraph.links.length).toBeGreaterThan(0);
  expect([
    ...primaryGraph.nodes.flatMap((node) => node.evidence ?? []),
    ...primaryGraph.links.flatMap((link) => link.evidence ?? []),
  ].length).toBeGreaterThan(0);
});

test("5. real Backboard handoff chat stores an evidence-backed answer", async ({ request }) => {
  firstSession = await apiPost<ChatSession>(request, "/api/chat/sessions", {
    workspaceId,
    title: "E2E unfinished PR handoff",
  });
  const result = await sendChat(request, firstSession.id, {
    content: "What does a new developer need to know before taking over this repo?",
    scanId: primaryScan.id,
  });
  firstSession = result.session;
  firstAssistantMessage = result.assistantMessage;

  expect(firstSession.assistantId).toBeTruthy();
  expect(firstSession.threadId).toBeTruthy();
  expect(firstAssistantMessage.content).toMatch(/handoff|developer|inspect|evidence|I do not have evidence/i);
  expect(firstAssistantMessage.backboardRunId ?? firstAssistantMessage.backboardMessageId).toBeTruthy();
  expect(firstAssistantMessage.citations.length > 0 || firstAssistantMessage.content.includes("I do not have evidence")).toBe(true);

  const stored = await apiGet<{ messages: ChatMessage[] }>(
    request,
    `/api/chat/sessions/${encodeURIComponent(firstSession.id)}/messages`,
  );
  expect(stored.messages.some((message) => message.content === firstAssistantMessage.content)).toBe(true);
});

test("6. UI node deep dive answers what to inspect before changing a selected node", async ({ page }) => {
  await openRealExplore(page);
  const targetNode = primaryGraph.nodes[0];
  const nodeLocator = page.locator(`[data-testid="graph-node"][data-node-id="${targetNode.id}"]`);
  const nodeLabel = targetNode.label;
  await nodeLocator.click({ force: true });
  await page.getByRole("button", { name: /handoff/i }).click();
  await page.getByTestId("chat-input").fill(`What should a new developer know before changing ${nodeLabel}?`);
  await page.getByTestId("send-chat").click();

  const answer = await latestAssistantMessage(page);
  await expect(answer).toContainText(nodeLabel, { timeout: 180_000 });
  await expect(answer).toContainText(/Confidence|evidence|\[E\d+\]/i);
});

test("7. UI edge deep dive answers connection risk with evidence", async ({ page }) => {
  await openRealExplore(page);
  const edge = primaryGraph.links.find((item) => (item.evidence?.length ?? 0) > 0) ?? primaryGraph.links[0];
  const edgeLocator = page.locator(`[data-testid="graph-edge"][data-edge-id="${edge.id}"]`);
  await expect(edgeLocator).toBeAttached({ timeout: 60_000 });
  await edgeLocator.click({ force: true });
  await page.getByRole("button", { name: /handoff/i }).click();
  await page.getByTestId("chat-input").fill(`What is risky about this ${edge.kind} connection for a handoff?`);
  await page.getByTestId("send-chat").click();

  const answer = await latestAssistantMessage(page);
  await expect(answer).toContainText(edge.kind, { timeout: 180_000 });
  await expect(answer).toContainText(/risk|risky|verify|inspect/i);
  await expect(answer).toContainText(/Confidence|evidence|\[E\d+\]/i);
});

test("8. mobile Explore handoff controls are accessible and panels stay in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRealExplore(page);

  const exportContext = page.getByRole("link", { name: /export context/i });
  const handoff = page.getByRole("button", { name: /handoff assistant/i });
  await expect(exportContext).toBeVisible();
  await expect(handoff).toBeVisible();

  const targetNode = primaryGraph.nodes[0];
  await page.locator(`[data-testid="graph-node"][data-node-id="${targetNode.id}"]`).click({ force: true });
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await handoff.click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
  const chatBox = await page.getByTestId("chat-panel").boundingBox();
  const detailBox = await page.getByTestId("detail-panel").boundingBox();
  expect(chatBox).toBeTruthy();
  expect(detailBox).toBeTruthy();
  expect(chatBox!.x).toBeGreaterThanOrEqual(0);
  expect(detailBox!.x).toBeGreaterThanOrEqual(0);
  expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(chatBox!.y).toBeGreaterThanOrEqual(0);
  expect(chatBox!.y + chatBox!.height).toBeLessThanOrEqual(detailBox!.y + 2);
  expect(detailBox!.y + detailBox!.height).toBeLessThanOrEqual(viewport!.height);
});

test("9. memory behavior reuses assistant id across handoff sessions", async ({ request }) => {
  expect(firstAssistantMessage.memoryOperationId ?? firstAssistantMessage.memoryError).toBeTruthy();

  secondSession = await apiPost<ChatSession>(request, "/api/chat/sessions", {
    workspaceId,
    title: "Second handoff session",
  });
  expect(secondSession.assistantId).toBe(firstSession.assistantId);

  const result = await sendChat(request, secondSession.id, {
    content: "From the prior handoff knowledge, what confirmed component should I inspect first?",
    scanId: primaryScan.id,
  });

  expect(result.session.assistantId).toBe(firstSession.assistantId);
  expect(result.session.threadId).toBeTruthy();
  expect(result.assistantMessage.memoryOperationId ?? result.assistantMessage.memoryError).toBeTruthy();
  expect(result.assistantMessage.content).toMatch(/inspect|component|handoff|evidence|I do not have evidence/i);
});

test("10. organization graph behavior explains repo connections or lack of evidence", async ({ request }) => {
  test.setTimeout(420_000);
  secondaryScan = await scanRepo(request, repos[1]);
  workspaceGraph = await apiGet<GraphData>(request, `/api/workspaces/${encodeURIComponent(workspaceId)}/graph`);

  expect(secondaryScan.status).toBe("completed");
  expect(workspaceGraph.nodes.length).toBeGreaterThan(primaryGraph.nodes.length);
  expect(workspaceGraph.links.length).toBeGreaterThan(0);

  const session = await apiPost<ChatSession>(request, "/api/chat/sessions", {
    workspaceId,
    title: "Org handoff",
  });
  const result = await sendChat(request, session.id, {
    content: "How do these repos connect for a new developer taking over unfinished work?",
  });

  if ((workspaceGraph.crossRepoConnections?.length ?? 0) > 0) {
    expect(result.assistantMessage.content).toMatch(/\[E\d+\]|connect|depends|repo/i);
  } else {
    expect(result.assistantMessage.content).toContain("I do not have evidence for that in the scanned repos yet.");
  }
});
});
