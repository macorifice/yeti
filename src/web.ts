// Local, read-only web dashboard. It serves one page and a small JSON API on 127.0.0.1.
// It shows the design side of a project; execution stays in Jira.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, loadDb, missingFor, type DB, type Project } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = join(here, "..", "public", "dashboard.html");
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

// Only https sites are linked, so a bad value in the environment cannot inject a link scheme
function jiraSite(): string | null {
  const site = process.env.JIRA_SITE;
  return site && /^https:\/\/[^\s"'<>]+$/.test(site) ? site.replace(/\/+$/, "") : null;
}

const jiraKey = (key?: string) => (key && JIRA_KEY.test(key) ? key : null);

// Flows are stored as fenced Mermaid blocks with the flow name as a %% comment
function flowParts(block: string) {
  const source = block.replace(/^```mermaid\n?/, "").replace(/\n?```$/, "");
  const name = source.match(/^\s*%%\s*(.+)$/m)?.[1]?.trim() || "Flow";
  return { name, source };
}

function counts(db: DB, p: Project) {
  const reqs = db.requirements.filter((r) => r.projectId === p.id);
  const stories = db.stories.filter((s) => s.projectId === p.id);
  const covered = new Set(stories.flatMap((s) => s.requirementIds ?? []));
  const musts = reqs.filter((r) => r.priority === "must");
  const criteria = stories.flatMap((s) => s.acceptanceCriteria.map((_, i) => Boolean(s.criteriaDone?.[i])));
  return {
    requirements: reqs.length,
    requirementsDone: reqs.filter((r) => r.status === "done").length,
    musts: musts.length,
    mustsDone: musts.filter((r) => r.status === "done").length,
    mustsCovered: musts.filter((r) => covered.has(r.id)).length,
    stories: stories.length,
    criteriaDone: criteria.filter(Boolean).length,
    criteriaTotal: criteria.length,
    inJira: reqs.filter((r) => r.jiraKey).length + stories.filter((s) => s.jiraKey).length,
  };
}

function listItem(db: DB, p: Project) {
  return {
    id: p.id,
    name: p.name,
    phase: p.closed ? "closed" : PHASES[p.phase],
    phaseIndex: p.closed ? PHASES.length : p.phase,
    phaseCount: PHASES.length,
    closed: p.closed,
    archived: Boolean(p.archived),
    mode: p.mode ?? "strict",
    missing: p.closed ? 0 : missingFor(db, p).length,
    counts: counts(db, p),
  };
}

function detail(db: DB, p: Project) {
  const reqs = db.requirements.filter((r) => r.projectId === p.id);
  const stories = db.stories.filter((s) => s.projectId === p.id);
  const storiesByReq = new Map<number, number[]>();
  for (const s of stories) {
    for (const rid of s.requirementIds ?? []) storiesByReq.set(rid, [...(storiesByReq.get(rid) ?? []), s.id]);
  }
  return {
    ...listItem(db, p),
    problem: p.problem,
    users: p.users,
    goal: p.goal,
    phases: [...PHASES],
    // The rule messages name the MCP tool to call; on the page the plain sentence is enough
    missingItems: p.closed ? [] : missingFor(db, p).map((m) => m.replace(/\s*\([^)]*\)\s*$/, "")),
    requirements: reqs.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      status: r.status,
      jiraKey: jiraKey(r.jiraKey),
      storyIds: storiesByReq.get(r.id) ?? [],
    })),
    stories: stories.map((s) => ({
      id: s.id,
      persona: s.persona,
      goal: s.goal,
      benefit: s.benefit,
      requirementIds: s.requirementIds ?? [],
      criteria: s.acceptanceCriteria.map((text, i) => ({ text, done: Boolean(s.criteriaDone?.[i]) })),
      jiraKey: jiraKey(s.jiraKey),
    })),
    rice: [...p.rice].sort((a, b) => b.score - a.score),
    decisions: db.decisions
      .filter((d) => d.projectId === p.id)
      .map((d) => ({ id: d.id, title: d.title, decision: d.decision, reason: d.reason, alternatives: d.alternatives ?? "", createdAt: d.createdAt })),
    flows: p.flows.map(flowParts),
    jiraSite: jiraSite(),
  };
}

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, port: number) {
  // Only answer requests addressed to this machine, so a web page cannot read the data
  // through a DNS name that points at 127.0.0.1
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 403, { error: "Forbidden host" });
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "The dashboard is read-only" });

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/") {
      const html = await readFile(PAGE_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": PAGE_CSP,
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(html);
    }
    if (url.pathname === "/api/projects") {
      const db = await loadDb();
      const withArchived = url.searchParams.get("archived") === "1";
      return sendJson(res, 200, db.projects.filter((p) => withArchived || !p.archived).map((p) => listItem(db, p)));
    }
    const match = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    if (match) {
      const db = await loadDb();
      const p = db.projects.find((x) => x.id === Number(match[1]));
      return p ? sendJson(res, 200, detail(db, p)) : sendJson(res, 404, { error: "Project not found" });
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, { error: (err as Error).message });
  }
}

// Starts the dashboard on 127.0.0.1. With tryNext, a busy port moves on to the next ones.
export async function startDashboard(opts: { port: number; tryNext?: boolean }): Promise<{ url: string; server: Server }> {
  const attempts = opts.tryNext ? 10 : 1;
  for (let i = 0; i < attempts; i++) {
    const server = createServer((req, res) => {
      void handle(req, res, (server.address() as AddressInfo).port);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port === 0 ? 0 : opts.port + i, "127.0.0.1", () => resolve());
      });
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || i === attempts - 1) throw err;
    }
  }
  throw new Error("No free port for the dashboard");
}
