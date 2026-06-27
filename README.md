# Atlas

Atlas is a hackathon prototype for understanding inherited codebases before you change them.

Paste a GitHub repo URL and Atlas turns the system into a navigable 3D graph: services, modules, databases, queues, auth layers, config surfaces, and external APIs. The goal is to help engineers and AI agents build a grounded handoff model quickly, especially when work is inherited from an unfinished PR or partially completed task.

The current demo uses a fictional `acme/payments-platform` bank payments system to show the intended product flow.

## What It Does

Atlas is built around one scan and three outputs:

- A human-readable 3D system map for exploration.
- An agent-ready context package with markdown files for every node, link, and system brief.
- An evidence-grounded handoff assistant that answers takeover questions using graph evidence and Backboard workspace memory.

The graph is not just a dependency chart. Nodes explain what each part owns, why it exists, how confident the scan is, and where the risk is. Edges are first-class too: clicking a connection shows the code path, contract, failure behavior, criticality, confidence, and "before you change this" notes.

## Product Flow

1. Paste a GitHub repository URL on the landing page.
2. Atlas runs a scan that looks for structure, imports, service calls, API contracts, queues, config, environment references, and external dependencies.
3. The app opens a 3D graph clustered by domain.
4. Filter by node type, search by keyword, or focus on high-risk areas.
5. Click a node to inspect ownership, dependencies, dependents, confidence, and risk flags.
6. Click an edge to inspect the actual connection between two parts of the system.
7. Open the Handoff assistant to ask what to inspect, change, or verify next.
8. Export the generated context package for agents or future handoff.

## Demo Pages

- `/` is the landing page with the repo input and scan animation.
- `/explore` is the interactive 3D graph for the sample payments platform.
- `/export` previews and downloads generated markdown context files.

## Why It Exists

Large inherited systems are hard because the important knowledge is spread across code, docs, config, queues, third-party APIs, and tribal memory. Atlas tries to make that shape visible. It shows what talks to what, which links are risky, and which conclusions are confirmed versus inferred.

The same scan powers the visual map, markdown export, and handoff assistant, so humans and agents work from the same model instead of separate guesses.

## Handoff Assistant

The Explore page includes a Handoff assistant panel. It is intentionally not a generic chatbot: before calling Backboard it retrieves deterministic local context from SQLite, including workspace graph summaries, relevant repo scans, selected nodes or edges, graph neighborhoods, evidence snippets, generated context markdown, previous chat messages, and locally indexed Backboard memory facts.

Use it for questions like:

- "What does a new developer need to know before taking over this repo?"
- "What should a new developer know before changing this module?"
- "What is risky about this connection for a handoff?"
- "How do these repos connect for someone inheriting unfinished work?"
- "Show me evidence for that."

Answers are expected to cite retrieved evidence when making architecture or handoff claims. If evidence is weak or absent, the assistant should say that the claim is inferred or uncertain, or: "I do not have evidence for that in the scanned repos yet."

Backboard memory is reused at the Atlas workspace level. Atlas stores one assistant id per workspace and one Backboard thread per Atlas chat session. Durable memory writes are limited to evidence-backed repo/system/task handoff facts, include stable evidence ids plus commit/repo metadata, and record memory write errors in SQLite instead of failing silently.

## Tech Stack

- Next.js
- React
- TypeScript
- Tailwind CSS
- Three.js / `react-force-graph-3d`
- `react-markdown` for context previews

## Run Locally

### Frontend

```bash
cd web
npm install
npm run dev
```

Then open the local Next.js URL shown in the terminal.

### Backend

The backend is a separate Fastify service under `api/`. It clones public
GitHub repositories, runs deterministic JS/TS scanners, sends compact scan
artifacts to Backboard, stores Backboard assistant/thread metadata, and
persists evidence-backed graph data in SQLite.

Atlas is also intended to support new-developer and AI-agent handoff from
unfinished Git PRs, but this backend slice does not solve PR intake yet. Scan
context therefore preserves the foundation for that next slice: stable evidence
IDs, snippets, file paths, and line ranges that link deterministic scanner facts
back to graph nodes and edges. Future PR diff tooling must still fetch PR
base/head refs, changed files, unresolved task state, failures, and attempted
commands before claiming an unfinished-PR handoff is complete.

```bash
cp .env.example .env
# Fill BACKBOARD_API_KEY in .env. Do not commit .env.

cd api
npm install
npm run migrate
npm run dev
```

The default API URL is `http://127.0.0.1:3001`. SQLite is stored at
`.atlas/atlas.db` from `DATABASE_URL=file:./.atlas/atlas.db`.

### Required API Endpoints

- `POST /api/scans`
- `GET /api/scans/:scanId`
- `GET /api/scans/:scanId/events`
- `GET /api/scans/:scanId/graph`
- `GET /api/workspaces/:workspaceId/graph`
- `GET /api/repositories`
- `GET /api/nodes/:nodeId`
- `GET /api/edges/:edgeId`
- `GET /api/scans/:scanId/context`
- `GET /api/scans/:scanId/handoff`
- `GET /api/scans/:scanId/export`
- `POST /api/chat/sessions`
- `GET /api/chat/sessions/:sessionId`
- `GET /api/chat/sessions/:sessionId/messages`
- `POST /api/chat/sessions/:sessionId/messages`
- `POST /api/chat/sessions/:sessionId/memory-sync`

### Handoff API Example

```bash
curl -s -X POST http://127.0.0.1:3001/api/chat/sessions \
  -H 'Content-Type: application/json' \
  -d '{"title":"Unfinished PR handoff"}'

curl -s -X POST http://127.0.0.1:3001/api/chat/sessions/<session-id>/messages \
  -H 'Content-Type: application/json' \
  -d '{"content":"What does a new developer need to know before taking over this repo?","scanId":"<scan-id>"}'
```

The export package includes:

- `system-brief.md`
- `node-context/*.md`
- `link-context/*.md`
- `handoff/handoff-map.json`
- `backboard/backboard-record.json`

Backboard synthesis is exported as advisory metadata only. Confirmed graph and
handoff claims come from deterministic scanner evidence. Backboard memory writes
store evidence-indexed durable facts and safe assistant/thread/run/memory
operation handles; the export does not include API keys or raw secret values.

### Verification

Backend checks:

```bash
cd api
npm run typecheck
npm test
```

Frontend checks:

```bash
cd web
npx tsc -p tsconfig.json --noEmit
npm run lint
npm run build
```

Real Backboard verification requires the local `.env` to include
`BACKBOARD_API_KEY`. Start the backend, then run:

```bash
cd api
npm run verify:public
```

The verification script scans:

- `https://github.com/fastify/fastify-plugin`
- `https://github.com/fastify/fastify-autoload`

Those repos are small public JS/TS repositories with a package-level
relationship: `fastify-autoload` depends on the `fastify-plugin` package
produced by `fastify-plugin`. Atlas uses that dependency declaration as
evidence for a supported cross-repo workspace graph connection.

Real handoff E2E verification also requires `BACKBOARD_API_KEY`:

```bash
cd api
npm run test:e2e
```

The Playwright config loads `.env` from the repository root and `api/.env`
without printing secret values, so the command above uses the same documented
environment path as local scans. The suite starts the backend and frontend on
isolated local ports, enables the optional API bearer-token guard with a dummy
E2E token, verifies missing/invalid auth rejection for scan and chat routes,
initializes SQLite, scans public repos, calls the real Backboard API, verifies
stored handoff answers and memory behavior, and drives node and edge deep dives
in the Explore UI.
