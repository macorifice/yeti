import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Data is stored in a local JSON file next to the project
const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PRODUCT_DESIGN_DB ?? join(here, "..", "data", "db.json");

// Mandatory phases, in order. A project advances only when the current phase is complete.
const PHASES = ["discovery", "definition", "prioritization", "flows", "verification"] as const;

type Priority = "must" | "should" | "could" | "wont";

type Requirement = {
  id: number;
  projectId?: number;
  title: string;
  description: string;
  priority: Priority;
  status: "open" | "done";
  createdAt: string;
};

type Story = {
  id: number;
  projectId?: number;
  persona: string;
  goal: string;
  benefit: string;
  acceptanceCriteria: string[];
  createdAt: string;
};

type Project = {
  id: number;
  name: string;
  problem: string;
  users: string;
  goal: string;
  phase: number; // index into PHASES
  closed: boolean;
  mode?: "strict" | "free"; // missing when created before modes existed: treated as strict
  rice: { name: string; score: number }[];
  flows: string[];
  createdAt: string;
};

type DB = {
  projects: Project[];
  requirements: Requirement[];
  stories: Story[];
  nextId: number;
};

async function loadDb(): Promise<DB> {
  try {
    const db = JSON.parse(await readFile(DB_PATH, "utf8"));
    return { projects: [], ...db };
  } catch {
    return { projects: [], requirements: [], stories: [], nextId: 1 };
  }
}

async function saveDb(db: DB): Promise<void> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const scoreRice = (i: { reach: number; impact: number; confidence: number; effort: number }) =>
  Math.round(((i.reach * i.impact * i.confidence) / i.effort) * 100) / 100;

// What is still missing to complete the project's current phase
function missingFor(db: DB, p: Project): string[] {
  const reqs = db.requirements.filter((r) => r.projectId === p.id);
  const stories = db.stories.filter((s) => s.projectId === p.id);
  switch (PHASES[p.phase]) {
    case "discovery":
      return [];
    case "definition":
      return [
        ...(reqs.length ? [] : ["at least one requirement (add_requirement with projectId)"]),
        ...(stories.length ? [] : ["at least one user story (add_user_story with projectId)"]),
      ];
    case "prioritization":
      return p.rice.length ? [] : ["at least one RICE scoring (prioritize_rice with projectId)"];
    case "flows":
      return p.flows.length ? [] : ["at least one flow diagram (map_user_flow with projectId)"];
    case "verification":
      return reqs
        .filter((r) => r.priority === "must" && r.status !== "done")
        .map((r) => `unfinished must: "${r.title}" (id ${r.id})`);
  }
}

const server = new McpServer({ name: "yeti", version: "0.2.0" });

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
    },
  },
  async ({ persona, goal, benefit, acceptanceCriteria, projectId }) => {
    const db = await loadDb();
    const story: Story = {
      id: db.nextId++,
      ...(projectId !== undefined ? { projectId } : {}),
      persona,
      goal,
      benefit,
      acceptanceCriteria,
      createdAt: new Date().toISOString(),
    };
    db.stories.push(story);
    await saveDb(db);
    const md = [
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
          }),
        )
        .min(2),
      projectId: projectIdSchema,
    },
  },
  async ({ name, steps, projectId }) => {
    const outOfRange = steps.some((s) => [s.yes, s.no].some((t) => t !== undefined && t >= steps.length));
    if (outOfRange) return text(`Step index out of range: there are ${steps.length} steps (0 to ${steps.length - 1}).`);

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
      } else if (i + 1 < steps.length) {
        lines.push(`  S${i} --> S${i + 1}`);
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
    },
  },
  async ({ projectId, format }) => {
    const db = await loadDb();
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) return text(`Project ${projectId} not found.`);
    const order = { must: 0, should: 1, could: 2, wont: 3 };
    const reqs = db.requirements
      .filter((r) => r.projectId === p.id)
      .sort((a, b) => order[a.priority] - order[b.priority]);
    const stories = db.stories.filter((x) => x.projectId === p.id);

    if (format === "csv") {
      const cell = (v: unknown) => {
        const str = String(v ?? "");
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const rows = [["type", "id", "title", "priority", "status", "details"].join(",")];
      for (const r of reqs) {
        rows.push([ "requirement", r.id, r.title, r.priority, r.status, r.description ].map(cell).join(","));
      }
      for (const st of stories) {
        const details = `so that ${st.benefit}; criteria: ${st.acceptanceCriteria.join(" | ")}`;
        rows.push([ "story", st.id, `As a ${st.persona}, I want ${st.goal}`, "", "", details ].map(cell).join(","));
      }
      return text(rows.join("\n"));
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
            ...st.acceptanceCriteria.map((c) => `- [ ] ${c}`),
            "",
          ])
        : ["_None yet._"]),
    ];
    return text(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
