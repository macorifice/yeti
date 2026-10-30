#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderDashboard, type ProjectView } from "./dashboard.js";
import { startDashboard } from "./web.js";
import { PROJECT_TEMPLATES } from "./templates.js";
import { jiraMapping, jiraTracker } from "./integrations/jira.js";
import { githubMapping, githubTracker } from "./integrations/github.js";
import { TrackerError } from "./integrations/tracker.js";
import { DB_PATH, PHASES, loadDb, saveDb, missingFor, type Decision, type Priority, type Project, type Requirement, type Story } from "./store.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const scoreRice = (i: { reach: number; impact: number; confidence: number; effort: number }) =>
  Math.round(((i.reach * i.impact * i.confidence) / i.effort) * 100) / 100;

// The version comes from package.json, so it cannot drift from the published one
const { version } = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
const server = new McpServer({ name: "yeti", version });

const projectIdSchema = z.number().int().optional().describe("Id of the project to link this item to");

server.registerTool(
  "create_project",
  {
    description: "Create a design project. It starts in the 'discovery' phase: problem, users and goal are required. Mode 'strict' (default) blocks advancing until each phase is complete; 'free' allows advancing and reports what was skipped.",
    inputSchema: {
      name: z.string().min(2),
      problem: z.string().describe("The problem it solves"),
      users: z.string().describe("Who it is for"),
      goal: z.string().describe("What the user or business should achieve"),
      mode: z.enum(["strict", "free"]).default("strict"),
    },
  },
  async ({ name, problem, users, goal, mode }) => {
    const db = await loadDb();
    const project: Project = {
      id: db.nextId++,
      name,
      problem,
      users,
      goal,
      mode,
      phase: 0,
      closed: false,
      rice: [],
      flows: [],
      createdAt: new Date().toISOString(),
    };
    db.projects.push(project);
    await saveDb(db);
    return text({ ...project, phase: PHASES[0] });
  },
);

server.registerTool(
  "list_projects",
  {
    description: "List projects with their id, name, phase and status. Use it to find a projectId.",
    inputSchema: {
      includeClosed: z.boolean().default(true).describe("Set to false to hide closed projects"),
      includeArchived: z.boolean().default(false).describe("Set to true to also list archived projects"),
    },
  },
  async ({ includeClosed, includeArchived }) => {
    const db = await loadDb();
    const projects = db.projects
      .filter((p) => (includeClosed || !p.closed) && (includeArchived || !p.archived))
      .map((p) => ({
        id: p.id,
        name: p.name,
        phase: p.closed ? "closed" : PHASES[p.phase],
        mode: p.mode ?? "strict",
      }));
    return text(projects.length ? projects : "No projects found.");
  },
);

server.registerTool(
  "update_requirement",
  {
    description: "Change a requirement's title, description or priority. Only the fields you pass are changed.",
    inputSchema: {
      id: z.number().int(),
      title: z.string().min(3).optional(),
      description: z.string().optional(),
      priority: z.enum(["must", "should", "could", "wont"]).optional(),
    },
  },
  async ({ id, title, description, priority }) => {
    const db = await loadDb();
    const req = db.requirements.find((r) => r.id === id);
    if (!req) return text(`Requirement ${id} not found.`);
    if (title !== undefined) req.title = title;
    if (description !== undefined) req.description = description;
    if (priority !== undefined) req.priority = priority;
    await saveDb(db);
    return text(req);
  },
);

server.registerTool(
  "delete_requirement",
  {
    description: "Delete a requirement. It is also removed from the requirementIds of any user story that covered it.",
    inputSchema: { id: z.number().int() },
  },
  async ({ id }) => {
    const db = await loadDb();
    const before = db.requirements.length;
    db.requirements = db.requirements.filter((r) => r.id !== id);
    if (db.requirements.length === before) return text(`Requirement ${id} not found.`);
    for (const s of db.stories) {
      if (s.requirementIds) s.requirementIds = s.requirementIds.filter((rid) => rid !== id);
    }
    await saveDb(db);
    return text(`Requirement ${id} deleted.`);
  },
);

server.registerTool(
  "delete_user_story",
  {
    description: "Delete a user story.",
    inputSchema: { id: z.number().int() },
  },
  async ({ id }) => {
    const db = await loadDb();
    const before = db.stories.length;
    db.stories = db.stories.filter((s) => s.id !== id);
    if (db.stories.length === before) return text(`User story ${id} not found.`);
    await saveDb(db);
    return text(`User story ${id} deleted.`);
  },
);

server.registerTool(
  "set_criterion_status",
  {
    description: "Mark one acceptance criterion of a user story as done or not done. The index is 0-based, in the order of the criteria.",
    inputSchema: {
      storyId: z.number().int(),
      index: z.number().int().min(0),
      done: z.boolean(),
    },
  },
  async ({ storyId, index, done }) => {
    const db = await loadDb();
    const st = db.stories.find((x) => x.id === storyId);
    if (!st) return text(`User story ${storyId} not found.`);
    if (index >= st.acceptanceCriteria.length) return text(`Criterion ${index} out of range: the story has ${st.acceptanceCriteria.length}.`);
    const flags = st.acceptanceCriteria.map((_, i) => st.criteriaDone?.[i] ?? false);
    flags[index] = done;
    st.criteriaDone = flags;
    await saveDb(db);
    return text(st);
  },
);

server.registerTool(
  "archive_project",
  {
    description: "Archive or unarchive a project. Archived projects are hidden from list_projects by default. Nothing is deleted.",
    inputSchema: {
      projectId: z.number().int(),
      archived: z.boolean().default(true),
    },
  },
  async ({ projectId, archived }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    p.archived = archived;
    await saveDb(db);
    return text(`Project ${projectId} ${archived ? "archived" : "unarchived"}.`);
  },
);

server.registerTool(
  "set_project_mode",
  {
    description: "Change a project's mode: 'strict' or 'free'. Applies from the next phase change.",
    inputSchema: {
      projectId: z.number().int(),
      mode: z.enum(["strict", "free"]),
    },
  },
  async ({ projectId, mode }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    p.mode = mode;
    await saveDb(db);
    return text({ id: p.id, name: p.name, mode });
  },
);

server.registerTool(
  "update_project",
  {
    description: "Change a project's name, problem, users or goal. Only the fields you pass are changed.",
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().min(2).optional(),
      problem: z.string().optional(),
      users: z.string().optional(),
      goal: z.string().optional(),
    },
  },
  async ({ projectId, name, problem, users, goal }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    if (name !== undefined) p.name = name;
    if (problem !== undefined) p.problem = problem;
    if (users !== undefined) p.users = users;
    if (goal !== undefined) p.goal = goal;
    await saveDb(db);
    return text(p);
  },
);

server.registerTool(
  "search_items",
  {
    description: "Search requirements and user stories by text (case-insensitive). Optionally limit to one project.",
    inputSchema: {
      query: z.string().min(2),
      projectId: projectIdSchema,
    },
  },
  async ({ query, projectId }) => {
    const db = await loadDb();
    const q = query.toLowerCase();
    const has = (...fields: string[]) => fields.some((f) => f.toLowerCase().includes(q));
    const inProject = (x: { projectId?: number }) => projectId === undefined || x.projectId === projectId;
    const hits = [
      ...db.requirements
        .filter((r) => inProject(r) && has(r.title, r.description))
        .map((r) => ({ type: "requirement", id: r.id, projectId: r.projectId, title: r.title })),
      ...db.stories
        .filter((st) => inProject(st) && has(st.persona, st.goal, st.benefit, ...st.acceptanceCriteria))
        .map((st) => ({ type: "story", id: st.id, projectId: st.projectId, title: `As a ${st.persona}, I want ${st.goal}` })),
    ];
    return text(hits.length ? hits : `No items match "${query}".`);
  },
);

server.registerTool(
  "duplicate_project",
  {
    description: "Create a new project from an existing one, copying its requirements and user stories as open items. Useful as a template for a new client or product. Statuses and RICE scores are not copied.",
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().min(2),
    },
  },
  async ({ projectId, name }) => {
    const db = await loadDb();
    const src = db.projects.find((x) => x.id === projectId);
    if (!src) return text(`Project ${projectId} not found.`);
    const copy: Project = {
      id: db.nextId++,
      name,
      problem: src.problem,
      users: src.users,
      goal: src.goal,
      mode: src.mode,
      phase: 0,
      closed: false,
      rice: [],
      flows: [],
      createdAt: new Date().toISOString(),
    };
    db.projects.push(copy);

    // Copy requirements, remembering the new id for each old one
    const reqIdMap = new Map<number, number>();
    for (const r of db.requirements.filter((x) => x.projectId === src.id)) {
      const newId = db.nextId++;
      reqIdMap.set(r.id, newId);
      db.requirements.push({ ...r, id: newId, projectId: copy.id, status: "open", createdAt: new Date().toISOString() });
    }
    // Copy stories, pointing their requirementIds at the copied requirements
    for (const st of db.stories.filter((x) => x.projectId === src.id)) {
      const linked = (st.requirementIds ?? []).map((id) => reqIdMap.get(id)).filter((id): id is number => id !== undefined);
      db.stories.push({
        ...st,
        id: db.nextId++,
        projectId: copy.id,
        requirementIds: linked.length ? linked : undefined,
        criteriaDone: undefined,
        createdAt: new Date().toISOString(),
      });
    }
    await saveDb(db);
    return text(copy);
  },
);

// Parses CSV text into rows, handling quoted fields with commas, quotes and newlines
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

server.registerTool(
  "import_requirements",
  {
    description: "Import requirements and user stories from CSV text, in the format produced by export_backlog. Requirement rows need type and title; story rows need persona, goal, benefit and criteria (separated by ' | '). Story-to-requirement links are not restored.",
    inputSchema: {
      projectId: z.number().int(),
      csv: z.string().min(1),
    },
  },
  async ({ projectId, csv }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const [header, ...rows] = parseCsv(csv);
    const col = (name: string) => header.indexOf(name);
    const iType = col("type"), iTitle = col("title"), iPriority = col("priority"), iDetails = col("details");
    const iPersona = col("persona"), iGoal = col("goal"), iBenefit = col("benefit"), iCriteria = col("criteria");
    if (iType < 0 || iTitle < 0) return text("CSV header must include 'type' and 'title' columns.");
    const priorities = ["must", "should", "could", "wont"];
    let imported = 0, skipped = 0;
    for (const r of rows) {
      if (r[iType] === "requirement" && r[iTitle]) {
        const priority = priorities.includes(r[iPriority]) ? (r[iPriority] as Priority) : "should";
        db.requirements.push({
          id: db.nextId++,
          projectId: p.id,
          title: r[iTitle],
          description: iDetails >= 0 ? r[iDetails] ?? "" : "",
          priority,
          status: "open",
          createdAt: new Date().toISOString(),
        });
        imported++;
      } else if (
        r[iType] === "story" &&
        iPersona >= 0 && iGoal >= 0 && iBenefit >= 0 && iCriteria >= 0 &&
        r[iPersona] && r[iGoal] && r[iBenefit] && r[iCriteria]
      ) {
        db.stories.push({
          id: db.nextId++,
          projectId: p.id,
          persona: r[iPersona],
          goal: r[iGoal],
          benefit: r[iBenefit],
          acceptanceCriteria: r[iCriteria].split(" | ").filter(Boolean),
          createdAt: new Date().toISOString(),
        });
        imported++;
      } else {
        skipped++;
      }
    }
    await saveDb(db);
    return text({ imported, skipped });
  },
);

// Work trackers Yeti can send items to. Each one is an adapter behind the Tracker interface.
type TrackerName = "jira" | "github";
const mappingFor = (name: TrackerName) => (name === "jira" ? jiraMapping : githubMapping);
const trackerFor = (name: TrackerName) => (name === "jira" ? jiraTracker() : githubTracker());
const trackerName = z.enum(["jira", "github"]);

const noTracker = "This project has no work tracker yet. Set one with set_project_tracker (a Jira project key, or owner/repo for GitHub).";

// Sends the project's requirements and stories to its tracker. The core decides what to send,
// skips what was already sent, saves the keys, and handles dry runs.
async function pushToTracker(args: { projectId: number; dryRun: boolean; limit?: number; update: boolean }) {
  const { projectId, dryRun, limit, update } = args;
  const db = await loadDb();
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return text(`Project ${projectId} not found.`);
  if (!p.tracker) return text(noTracker);
  const name: TrackerName = p.tracker.kind;
  const projectKey = p.tracker.kind === "jira" ? p.tracker.target : "";
  const mapping = mappingFor(name);

  const items = [
    ...db.requirements
      .filter((r) => r.projectId === p.id)
      .map((r) => ({
        kind: "requirement" as const,
        ref: r,
        issueType: mapping.issueType("requirement"),
        summary: r.title,
        priority: mapping.priorityName(r.priority),
        description: r.description,
      })),
    ...db.stories
      .filter((st) => st.projectId === p.id)
      .map((st) => ({
        kind: "story" as const,
        ref: st,
        issueType: mapping.issueType("story"),
        summary: `As a ${st.persona}, I want ${st.goal}`,
        priority: undefined as string | undefined,
        description: [`So that ${st.benefit}.`, "", "Acceptance criteria:", ...st.acceptanceCriteria.map((c) => `- ${c}`)].join("\n"),
      })),
  ];
  const pending = items.filter((i) => !i.ref.jiraKey);
  const linked = items.filter((i) => i.ref.jiraKey);
  const batch = pending.slice(0, limit ?? pending.length);
  const skippedAlreadySent = linked.length;

  if (dryRun) {
    return text({
      dryRun: true,
      tracker: name,
      count: batch.length,
      skippedAlreadySent,
      updates: update ? linked.map((i) => ({ key: i.ref.jiraKey, summary: i.summary })) : [],
      issues: batch.map((i) => ({ source: { kind: i.kind, id: i.ref.id }, issueType: i.issueType, project: projectKey, summary: i.summary, priority: i.priority, description: i.description })),
    });
  }

  const tracker = trackerFor(name);
  if (typeof tracker === "string") return text(tracker);
  const created: { source: string; key: string }[] = [];
  try {
    for (const i of batch) {
      const key = await tracker.create(projectKey, { issueType: i.issueType, summary: i.summary, description: i.description, priority: i.priority });
      i.ref.jiraKey = key;
      created.push({ source: `${i.kind} ${i.ref.id}`, key });
    }
  } catch (err) {
    await saveDb(db);
    if (err instanceof TrackerError) return text({ error: err.message, detail: err.detail, created });
    throw err;
  }

  const updated: string[] = [];
  if (update) {
    try {
      for (const i of linked) {
        await tracker.update(i.ref.jiraKey as string, { issueType: i.issueType, summary: i.summary, description: i.description, priority: i.priority });
        updated.push(i.ref.jiraKey as string);
      }
    } catch (err) {
      await saveDb(db);
      if (err instanceof TrackerError) return text({ error: err.message, detail: err.detail, created, updated });
      throw err;
    }
  }
  await saveDb(db);
  return text({ dryRun: false, tracker: name, created, updated, skippedAlreadySent });
}

// Reads the status of linked issues in the project's tracker and marks matching items done, or reopens what it completed
async function syncWithTracker(projectId: number) {
  const db = await loadDb();
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return text(`Project ${projectId} not found.`);
  if (!p.tracker) return text(noTracker);
  const tracker = trackerFor(p.tracker.kind);
  if (typeof tracker === "string") return text(tracker);

  const linkedReqs = db.requirements.filter((r) => r.projectId === p.id && r.jiraKey);
  const linkedStories = db.stories.filter((st) => st.projectId === p.id && st.jiraKey);
  const completed: string[] = [];
  const reopened: string[] = [];
  const checked: string[] = [];

  try {
    for (const r of linkedReqs) {
      checked.push(r.jiraKey as string);
      const done = await tracker.isDone(r.jiraKey as string);
      if (done && r.status !== "done") {
        r.status = "done";
        r.doneBySync = true;
        completed.push(`requirement ${r.id} (${r.jiraKey})`);
      } else if (!done && r.doneBySync) {
        // Only reopen what sync itself completed; items closed by hand in Yeti stay as they are
        r.status = "open";
        r.doneBySync = false;
        reopened.push(`requirement ${r.id} (${r.jiraKey})`);
      }
    }
    for (const st of linkedStories) {
      checked.push(st.jiraKey as string);
      const done = await tracker.isDone(st.jiraKey as string);
      const allTicked = st.acceptanceCriteria.every((_, i) => st.criteriaDone?.[i]);
      if (done && !allTicked) {
        st.criteriaDone = st.acceptanceCriteria.map(() => true);
        st.doneBySync = true;
        completed.push(`story ${st.id} (${st.jiraKey})`);
      } else if (!done && st.doneBySync) {
        st.criteriaDone = st.acceptanceCriteria.map(() => false);
        st.doneBySync = false;
        reopened.push(`story ${st.id} (${st.jiraKey})`);
      }
    }
  } catch (err) {
    await saveDb(db);
    if (err instanceof TrackerError) return text({ error: err.message, checked, completed, reopened });
    throw err;
  }
  await saveDb(db);
  return text({ checked: checked.length, completed, reopened });
}

server.registerTool(
  "set_project_tracker",
  {
    description: "Bind a project to its work tracker: jira (with a Jira project key, e.g. PROJ) or github (with owner/repo). Set it once, before sending anything. A project with items already sent cannot change tracker.",
    inputSchema: {
      projectId: z.number().int(),
      kind: trackerName,
      target: z.string().min(2).describe("Jira project key (e.g. PROJ) for jira, or owner/repo for github"),
    },
  },
  async ({ projectId, kind, target }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const valid = kind === "jira" ? /^[A-Z][A-Z0-9]+$/.test(target) : /^[\w.-]+\/[\w.-]+$/.test(target);
    if (!valid) return text(kind === "jira" ? "A Jira project key looks like PROJ (uppercase letters and digits)." : "A GitHub target looks like owner/repo.");
    const linked = [...db.requirements, ...db.stories].some((x) => x.projectId === projectId && x.jiraKey);
    if (linked && p.tracker && (p.tracker.kind !== kind || p.tracker.target !== target)) {
      return text("This project already has items in its tracker. Keys from two trackers must not mix, so it cannot change tracker.");
    }
    p.tracker = { kind, target };
    await saveDb(db);
    return text({ id: p.id, name: p.name, tracker: p.tracker });
  },
);

server.registerTool(
  "push_to_tracker",
  {
    description: "Create the project's work items in its tracker: one Task per requirement and one Story per user story. Items already sent are skipped. With update: true, refreshes the items already linked. dryRun (default true) only lists what would be sent. Set the tracker first with set_project_tracker.",
    inputSchema: {
      projectId: z.number().int(),
      dryRun: z.boolean().default(true),
      limit: z.number().int().min(1).optional().describe("Send at most this many new items; useful to test with one"),
      update: z.boolean().default(false).describe("Also refresh the items already linked"),
    },
  },
  async (args) => pushToTracker(args),
);

server.registerTool(
  "sync_tracker",
  {
    description: "Read the status of the project's linked items in its tracker and mark them done or open in Yeti. Read-only on the tracker.",
    inputSchema: { projectId: z.number().int() },
  },
  async ({ projectId }) => syncWithTracker(projectId),
);

server.registerTool(
  "project_summary",
  {
    description: "Summarise a project's progress: requirements by priority and status, story coverage of musts, acceptance criteria done, RICE leader, Jira links and what is missing to close.",
    inputSchema: { projectId: z.number().int() },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const reqs = db.requirements.filter((r) => r.projectId === p.id);
    const stories = db.stories.filter((st) => st.projectId === p.id);

    const byPriority = { must: 0, should: 0, could: 0, wont: 0 };
    const doneByPriority = { must: 0, should: 0, could: 0, wont: 0 };
    for (const r of reqs) {
      byPriority[r.priority]++;
      if (r.status === "done") doneByPriority[r.priority]++;
    }
    const covered = new Set(stories.flatMap((st) => st.requirementIds ?? []));
    const musts = reqs.filter((r) => r.priority === "must");
    const criteria = stories.flatMap((st) => st.acceptanceCriteria.map((_, i) => Boolean(st.criteriaDone?.[i])));
    const top = [...p.rice].sort((a, b) => b.score - a.score)[0];

    return text({
      project: p.name,
      phase: p.closed ? "closed" : PHASES[p.phase],
      requirements: {
        total: reqs.length,
        byPriority,
        doneByPriority,
        open: reqs.filter((r) => r.status === "open").length,
      },
      musts: {
        total: musts.length,
        done: musts.filter((r) => r.status === "done").length,
        withStory: musts.filter((r) => covered.has(r.id)).length,
      },
      stories: {
        total: stories.length,
        criteriaDone: criteria.filter(Boolean).length,
        criteriaTotal: criteria.length,
      },
      rice: top ? { leader: top.name, score: top.score } : null,
      flows: p.flows.length,
      jiraLinked: reqs.filter((r) => r.jiraKey).length + stories.filter((st) => st.jiraKey).length,
      missing: p.closed ? [] : missingFor(db, p),
    });
  },
);

server.registerTool(
  "list_stories",
  {
    description: "List user stories, optionally for one project, with their ids, criteria state and Jira key. Use it to find a storyId.",
    inputSchema: { projectId: projectIdSchema },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const stories = db.stories
      .filter((st) => projectId === undefined || st.projectId === projectId)
      .map((st) => ({
        id: st.id,
        projectId: st.projectId,
        persona: st.persona,
        goal: st.goal,
        benefit: st.benefit,
        requirementIds: st.requirementIds ?? [],
        criteria: st.acceptanceCriteria.map((c, i) => ({ text: c, done: Boolean(st.criteriaDone?.[i]) })),
        jiraKey: st.jiraKey,
      }));
    return text(stories.length ? stories : "No user stories found.");
  },
);

server.registerTool(
  "delete_project",
  {
    description: "Permanently delete a project with its requirements and user stories. Requires confirm: true. This cannot be undone; issues already created in Jira are not touched.",
    inputSchema: {
      projectId: z.number().int(),
      confirm: z.boolean().describe("Must be true to delete"),
    },
  },
  async ({ projectId, confirm }) => {
    if (!confirm) return text("Deletion not confirmed. Pass confirm: true to delete the project permanently.");
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const reqCount = db.requirements.filter((r) => r.projectId === projectId).length;
    const storyCount = db.stories.filter((st) => st.projectId === projectId).length;
    db.projects = db.projects.filter((x) => x.id !== projectId);
    db.requirements = db.requirements.filter((r) => r.projectId !== projectId);
    db.stories = db.stories.filter((st) => st.projectId !== projectId);
    await saveDb(db);
    return text(`Project "${p.name}" deleted, with ${reqCount} requirement(s) and ${storyCount} user stor${storyCount === 1 ? "y" : "ies"}.`);
  },
);

server.registerTool(
  "update_user_story",
  {
    description: "Change a user story's persona, goal, benefit, linked requirements or acceptance criteria. Only the fields you pass change. Changing the criteria resets their done state.",
    inputSchema: {
      id: z.number().int(),
      persona: z.string().optional(),
      goal: z.string().optional(),
      benefit: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).min(1).optional(),
      requirementIds: z.array(z.number().int()).optional(),
    },
  },
  async ({ id, persona, goal, benefit, acceptanceCriteria, requirementIds }) => {
    const db = await loadDb();
    const st = db.stories.find((x) => x.id === id);
    if (!st) return text(`User story ${id} not found.`);
    const unknown = (requirementIds ?? []).filter((rid) => !db.requirements.some((r) => r.id === rid));
    if (unknown.length) return text(`Requirement(s) not found: ${unknown.join(", ")}.`);
    if (persona !== undefined) st.persona = persona;
    if (goal !== undefined) st.goal = goal;
    if (benefit !== undefined) st.benefit = benefit;
    if (requirementIds !== undefined) st.requirementIds = requirementIds.length ? requirementIds : undefined;
    if (acceptanceCriteria !== undefined) {
      st.acceptanceCriteria = acceptanceCriteria;
      st.criteriaDone = undefined;
      st.doneBySync = undefined;
    }
    await saveDb(db);
    return text(st);
  },
);

server.registerTool(
  "list_flows",
  {
    description: "List the flow diagrams saved in a project, with their index. Use the index to refer to a diagram.",
    inputSchema: { projectId: z.number().int() },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    return text(p.flows.length ? p.flows.map((diagram, index) => ({ index, diagram })) : "No flows saved for this project.");
  },
);

server.registerTool(
  "delete_flow",
  {
    description: "Delete one saved flow diagram from a project, by the index shown by list_flows.",
    inputSchema: {
      projectId: z.number().int(),
      index: z.number().int().min(0),
    },
  },
  async ({ projectId, index }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    if (index >= p.flows.length) return text(`Flow ${index} not found: the project has ${p.flows.length}.`);
    p.flows.splice(index, 1);
    await saveDb(db);
    return text(`Flow ${index} deleted. ${p.flows.length} flow(s) left.`);
  },
);

server.registerTool(
  "export_dashboard",
  {
    description: "Write a read-only HTML dashboard to data/exports/dashboard.html: phases, what is missing, musts covered by stories, RICE scores and flow diagrams. Open the file in a browser.",
    inputSchema: { projectId: projectIdSchema },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const list = db.projects.filter((p) => projectId === undefined || p.id === projectId);
    if (!list.length) return text(projectId === undefined ? "No projects yet." : `Project ${projectId} not found.`);
    const views: ProjectView[] = list.map((p) => {
      const reqs = db.requirements.filter((r) => r.projectId === p.id);
      const covered = new Set(db.stories.filter((st) => st.projectId === p.id).flatMap((st) => st.requirementIds ?? []));
      return {
        id: p.id,
        name: p.name,
        closed: p.closed,
        phases: [...PHASES],
        currentIndex: p.closed ? PHASES.length : p.phase,
        missing: p.closed ? [] : missingFor(db, p),
        reqs: reqs.map((r) => ({ id: r.id, title: r.title, priority: r.priority, done: r.status === "done", covered: covered.has(r.id) })),
        rice: p.rice,
        flows: p.flows,
      };
    });
    const file = join(dirname(DB_PATH), "exports", "dashboard.html");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderDashboard(views, new Date().toISOString()), "utf8");
    return text({ file, projects: views.length });
  },
);

let dashboardUrl: string | undefined;

server.registerTool(
  "open_dashboard",
  {
    description: "Start the local, read-only Yeti dashboard and return its address (http://127.0.0.1:...). It shows phases, what is missing, musts and their stories, RICE and flows, and refreshes by itself. It runs on this computer only, while Yeti runs.",
    inputSchema: {},
  },
  async () => {
    if (!dashboardUrl) {
      const { url, server: http } = await startDashboard({ port: 4321, tryNext: true });
      // Do not keep the process alive for the dashboard alone: when Claude closes Yeti, it stops too
      http.unref();
      dashboardUrl = url;
    }
    return text({ url: dashboardUrl });
  },
);

server.registerTool(
  "add_decision",
  {
    description: "Record a design decision for a project: what was chosen, why, and which alternatives were rejected. Decisions are kept with the project, so the reasons outlive the chat.",
    inputSchema: {
      projectId: z.number().int(),
      title: z.string().min(3).describe("Short name of the decision"),
      decision: z.string().min(3).describe("What was chosen"),
      reason: z.string().min(3).describe("Why it was chosen"),
      alternatives: z.string().optional().describe("What was considered and rejected"),
    },
  },
  async ({ projectId, title, decision, reason, alternatives }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const entry: Decision = {
      id: db.nextId++,
      projectId,
      title,
      decision,
      reason,
      ...(alternatives ? { alternatives } : {}),
      createdAt: new Date().toISOString(),
    };
    db.decisions.push(entry);
    await saveDb(db);
    return text(entry);
  },
);

server.registerTool(
  "list_decisions",
  {
    description: "List the design decisions recorded for a project, oldest first.",
    inputSchema: { projectId: z.number().int() },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const items = db.decisions.filter((d) => d.projectId === projectId);
    return text(items.length ? items : "No decisions recorded for this project.");
  },
);

server.registerTool(
  "list_templates",
  {
    description: "List the starter project templates: a marketplace MVP and a customer self-service portal. Use one with create_project_from_template.",
    inputSchema: {},
  },
  async () => {
    return text(PROJECT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      requirements: t.requirements.length,
      stories: t.stories.length,
    })));
  },
);

server.registerTool(
  "create_project_from_template",
  {
    description: "Create a project from a starter template. It starts in discovery with its requirements and user stories open, linked to each other. Adapt them afterwards with the usual tools.",
    inputSchema: {
      templateId: z.string(),
      name: z.string().min(2).optional().describe("Project name; defaults to the template name"),
    },
  },
  async ({ templateId, name }) => {
    const tpl = PROJECT_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return text(`Template "${templateId}" not found. Use list_templates to see the options.`);
    const db = await loadDb();
    const project: Project = {
      id: db.nextId++,
      name: name ?? tpl.name,
      problem: tpl.problem,
      users: tpl.users,
      goal: tpl.goal,
      phase: 0,
      closed: false,
      rice: [],
      flows: [],
      createdAt: new Date().toISOString(),
    };
    db.projects.push(project);
    const reqIds = new Map<string, number>();
    for (const r of tpl.requirements) {
      const req: Requirement = {
        id: db.nextId++,
        projectId: project.id,
        title: r.title,
        description: r.description,
        priority: r.priority,
        status: "open",
        createdAt: new Date().toISOString(),
      };
      db.requirements.push(req);
      reqIds.set(r.title, req.id);
    }
    for (const st of tpl.stories) {
      db.stories.push({
        id: db.nextId++,
        projectId: project.id,
        persona: st.persona,
        goal: st.goal,
        benefit: st.benefit,
        acceptanceCriteria: st.acceptanceCriteria,
        requirementIds: st.covers.map((t) => reqIds.get(t)).filter((id): id is number => id !== undefined),
        createdAt: new Date().toISOString(),
      });
    }
    await saveDb(db);
    return text({ projectId: project.id, name: project.name, requirements: tpl.requirements.length, stories: tpl.stories.length, phase: PHASES[0] });
  },
);

server.registerTool(
  "get_project",
  {
    description: "Show a project's status: current phase, what is missing to advance, and linked items.",
    inputSchema: { projectId: z.number().int() },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    return text({
      ...p,
      phase: p.closed ? "closed" : PHASES[p.phase],
      missing: p.closed ? [] : missingFor(db, p),
      requirementCount: db.requirements.filter((r) => r.projectId === p.id).length,
      storyCount: db.stories.filter((s) => s.projectId === p.id).length,
    });
  },
);

server.registerTool(
  "advance_phase",
  {
    description: "Move to the next phase. In 'strict' mode, it lists what is missing and does not advance. In 'free' mode, it advances and reports what was skipped. After 'verification' it closes the project.",
    inputSchema: { projectId: z.number().int() },
  },
  async ({ projectId }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    if (p.closed) return text("Project already closed.");
    const free = p.mode === "free";
    const missing = missingFor(db, p);
    if (missing.length && !free) return text({ phase: PHASES[p.phase], missing });
    const skipped = free ? missing : [];
    if (p.phase === PHASES.length - 1) {
      p.closed = true;
      await saveDb(db);
      return text(free ? { message: "Project closed (free mode).", skipped } : "Project closed: all must requirements are complete.");
    }
    p.phase++;
    await saveDb(db);
    return text({ phase: PHASES[p.phase], ...(skipped.length ? { skipped } : {}) });
  },
);

server.registerTool(
  "add_requirement",
  {
    description: "Record a product requirement with a MoSCoW priority (must, should, could, wont).",
    inputSchema: {
      title: z.string().min(3).describe("Short requirement title"),
      description: z.string().describe("What the system must do and why"),
      priority: z.enum(["must", "should", "could", "wont"]).default("should"),
      projectId: projectIdSchema,
    },
  },
  async ({ title, description, priority, projectId }) => {
    const db = await loadDb();
    const req: Requirement = {
      id: db.nextId++,
      ...(projectId !== undefined ? { projectId } : {}),
      title,
      description,
      priority,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    db.requirements.push(req);
    await saveDb(db);
    return text(req);
  },
);

server.registerTool(
  "list_requirements",
  {
    description: "List requirements, optionally filtered by priority, status and project. Most important first.",
    inputSchema: {
      priority: z.enum(["must", "should", "could", "wont"]).optional(),
      status: z.enum(["open", "done"]).optional(),
      projectId: projectIdSchema,
    },
  },
  async ({ priority, status, projectId }) => {
    const order = { must: 0, should: 1, could: 2, wont: 3 };
    const db = await loadDb();
    const items = db.requirements
      .filter(
        (r) =>
          (!priority || r.priority === priority) &&
          (!status || r.status === status) &&
          (projectId === undefined || r.projectId === projectId),
      )
      .sort((a, b) => order[a.priority] - order[b.priority]);
    return text(items.length ? items : "No requirements found.");
  },
);

server.registerTool(
  "set_requirement_status",
  {
    description: "Mark a requirement as open or done.",
    inputSchema: {
      id: z.number().int(),
      status: z.enum(["open", "done"]),
    },
  },
  async ({ id, status }) => {
    const db = await loadDb();
    const req = db.requirements.find((r) => r.id === id);
    if (!req) return text(`Requirement ${id} not found.`);
    req.status = status;
    await saveDb(db);
    return text(req);
  },
);

server.registerTool(
  "add_user_story",
  {
    description: "Create a user story in the format 'As a <persona> I want <goal> so that <benefit>', with acceptance criteria.",
    inputSchema: {
      persona: z.string().describe("Who uses the feature, e.g. 'craftsman'"),
      goal: z.string().describe("What they want to do"),
      benefit: z.string().describe("Why they want it"),
      acceptanceCriteria: z.array(z.string()).min(1).describe("Verifiable conditions that define done"),
      projectId: projectIdSchema,
      requirementIds: z.array(z.number().int()).optional().describe("Ids of the requirements this story covers"),
    },
  },
  async ({ persona, goal, benefit, acceptanceCriteria, projectId, requirementIds }) => {
    const db = await loadDb();
    const unknown = (requirementIds ?? []).filter((id) => !db.requirements.some((r) => r.id === id));
    if (unknown.length) return text(`Requirement(s) not found: ${unknown.join(", ")}.`);
    const story: Story = {
      id: db.nextId++,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(requirementIds?.length ? { requirementIds } : {}),
      persona,
      goal,
      benefit,
      acceptanceCriteria,
      createdAt: new Date().toISOString(),
    };
    db.stories.push(story);
    await saveDb(db);
    const md = [
      `Story ${story.id}`,
      "",
      `**As a** ${persona}, **I want** ${goal}, **so that** ${benefit}.`,
      "",
      "Acceptance criteria:",
      ...acceptanceCriteria.map((c) => `- [ ] ${c}`),
    ].join("\n");
    return text(md);
  },
);

server.registerTool(
  "prioritize_rice",
  {
    description: "Compute RICE scores (Reach × Impact × Confidence ÷ Effort) for a list of ideas and sort them. With projectId, saves the result to the project.",
    inputSchema: {
      items: z
        .array(
          z.object({
            name: z.string(),
            reach: z.number().positive().describe("How many people affected per period"),
            impact: z.number().min(0.25).max(3).describe("0.25 minimal, 0.5 low, 1 medium, 2 high, 3 massive"),
            confidence: z.number().min(0).max(1).describe("From 0 to 1"),
            effort: z.number().positive().describe("Person-weeks"),
          }),
        )
        .min(1),
      projectId: projectIdSchema,
    },
  },
  async ({ items, projectId }) => {
    const scored = items
      .map((i) => ({ name: i.name, score: scoreRice(i) }))
      .sort((a, b) => b.score - a.score);
    if (projectId !== undefined) {
      const db = await loadDb();
      const p = db.projects.find((x) => x.id === projectId);
      if (!p) return text(`Project ${projectId} not found.`);
      p.rice = scored;
      await saveDb(db);
    }
    return text(scored);
  },
);

server.registerTool(
  "map_user_flow",
  {
    description:
      "Generate a Mermaid flowchart from a list of steps. Steps are linked in order; a decision (diamond) gets a 'Yes' edge to the next step, or to 'yes' if set, and a 'No' edge to 'no' if set. With projectId, saves the diagram to the project.",
    inputSchema: {
      name: z.string(),
      steps: z
        .array(
          z.object({
            label: z.string(),
            decision: z.boolean().default(false).describe("true if this is a decision point (diamond)"),
            yes: z.number().int().min(0).optional().describe("Index of the step reached on Yes. Defaults to the next step"),
            no: z.number().int().min(0).optional().describe("Index of the step reached on No. Only for decisions; omit for no No branch"),
            next: z.number().int().min(0).optional().describe("Index of the step reached after this one (non-decisions). Defaults to the next step"),
            ends: z.boolean().default(false).describe("true if this step is a final step with no outgoing arrow"),
          }),
        )
        .min(2),
      projectId: projectIdSchema,
    },
  },
  async ({ name, steps, projectId }) => {
    const targets = steps.flatMap((s) => [s.yes, s.no, s.next]);
    if (targets.some((t) => t !== undefined && t >= steps.length)) {
      return text(`Step index out of range: there are ${steps.length} steps (0 to ${steps.length - 1}).`);
    }

    const lines = ["flowchart TD", `  %% ${name}`];
    steps.forEach((s, i) => {
      const id = `S${i}`;
      lines.push(s.decision ? `  ${id}{${s.label}}` : `  ${id}[${s.label}]`);
    });
    steps.forEach((s, i) => {
      if (s.decision) {
        const yes = s.yes ?? (i + 1 < steps.length ? i + 1 : undefined);
        if (yes !== undefined) lines.push(`  S${i} -- Yes --> S${yes}`);
        if (s.no !== undefined) lines.push(`  S${i} -- No --> S${s.no}`);
      } else if (!s.ends) {
        const target = s.next ?? (i + 1 < steps.length ? i + 1 : undefined);
        if (target !== undefined) lines.push(`  S${i} --> S${target}`);
      }
    });
    const diagram = "```mermaid\n" + lines.join("\n") + "\n```";
    if (projectId !== undefined) {
      const db = await loadDb();
      const p = db.projects.find((x) => x.id === projectId);
      if (!p) return text(`Project ${projectId} not found.`);
      p.flows.push(diagram);
      await saveDb(db);
    }
    return text(diagram);
  },
);

server.registerTool(
  "export_backlog",
  {
    description: "Export a project backlog as Markdown or CSV: requirements (most important first) and user stories.",
    inputSchema: {
      projectId: z.number().int(),
      format: z.enum(["markdown", "csv"]).default("markdown"),
      save: z.boolean().default(false).describe("Also write the file to data/exports/"),
    },
  },
  async ({ projectId, format, save }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const order = { must: 0, should: 1, could: 2, wont: 3 };
    const reqs = db.requirements
      .filter((r) => r.projectId === p.id)
      .sort((a, b) => order[a.priority] - order[b.priority]);
    const stories = db.stories.filter((x) => x.projectId === p.id);

    const finish = async (content: string, ext: "csv" | "markdown") => {
      if (!save) return text(content);
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `project-${p.id}`;
      const file = join(dirname(DB_PATH), "exports", `${slug}.${ext === "csv" ? "csv" : "md"}`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      return text(`Saved to ${file}`);
    };

    if (format === "csv") {
      const cell = (v: unknown) => {
        const str = String(v ?? "");
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const rows = [["type", "id", "title", "priority", "status", "details", "persona", "goal", "benefit", "criteria"].join(",")];
      for (const r of reqs) {
        rows.push([ "requirement", r.id, r.title, r.priority, r.status, r.description, "", "", "", "" ].map(cell).join(","));
      }
      for (const st of stories) {
        const details = `so that ${st.benefit}; criteria: ${st.acceptanceCriteria.map((c, i) => (st.criteriaDone?.[i] ? `[x] ${c}` : c)).join(" | ")}`;
        rows.push([ "story", st.id, `As a ${st.persona}, I want ${st.goal}`, "", "", details, st.persona, st.goal, st.benefit, st.acceptanceCriteria.join(" | ") ].map(cell).join(","));
      }
      return finish(rows.join("\n"), "csv");
    }

    const lines = [
      `# ${p.name} — backlog`,
      "",
      `**Problem:** ${p.problem}`,
      `**Users:** ${p.users}`,
      `**Goal:** ${p.goal}`,
      "",
      "## Requirements",
      "",
      ...(reqs.length
        ? reqs.map((r) => `- [${r.status === "done" ? "x" : " "}] **${r.priority.toUpperCase()}** ${r.title}: ${r.description}`)
        : ["_None yet._"]),
      "",
      "## User stories",
      "",
      ...(stories.length
        ? stories.flatMap((st) => [
            `### Story ${st.id}`,
            "",
            `As a ${st.persona}, I want ${st.goal}, so that ${st.benefit}.`,
            "",
            ...st.acceptanceCriteria.map((c, i) => `- [${st.criteriaDone?.[i] ? "x" : " "}] ${c}`),
            "",
          ])
        : ["_None yet._"]),
    ];
    return finish(lines.join("\n"), "markdown");
  },
);

// "yeti-mcp dashboard [--port 4321]" runs only the dashboard; anything else runs the MCP server
const args = process.argv.slice(2);
if (args[0] === "dashboard") {
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 4321;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("--port needs a number between 0 and 65535");
    process.exit(1);
  }
  const { url } = await startDashboard({ port });
  console.log(`Yeti dashboard: ${url}`);
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
