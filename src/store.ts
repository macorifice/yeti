// Storage and project rules shared by the MCP server and the dashboard.
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Data is stored in SQLite, next to the project unless PRODUCT_DESIGN_DB says otherwise
const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.PRODUCT_DESIGN_DB ?? join(here, "..", "data", "yeti.sqlite");
// JSON file used by earlier versions; imported once if found next to the database
const LEGACY_JSON_PATH = join(dirname(DB_PATH), "db.json");

// Mandatory phases, in order. A project advances only when the current phase is complete.
export const PHASES = ["discovery", "definition", "prioritization", "flows", "verification"] as const;

export type Priority = "must" | "should" | "could" | "wont";

export type Requirement = {
  id: number;
  projectId?: number;
  jiraKey?: string; // set once the issue exists in Jira
  title: string;
  description: string;
  priority: Priority;
  status: "open" | "done";
  doneBySync?: boolean; // true when sync_from_jira marked it done, so it may reopen
  createdAt: string;
};

export type Story = {
  id: number;
  projectId?: number;
  jiraKey?: string; // set once the issue exists in Jira
  requirementIds?: number[]; // requirements this story covers
  persona: string;
  goal: string;
  benefit: string;
  acceptanceCriteria: string[];
  criteriaDone?: boolean[]; // same order as acceptanceCriteria
  doneBySync?: boolean; // true when sync_from_jira ticked the criteria, so it may reopen
  createdAt: string;
};

export type Project = {
  id: number;
  name: string;
  problem: string;
  users: string;
  goal: string;
  phase: number; // index into PHASES
  closed: boolean;
  archived?: boolean; // hidden from list_projects unless asked for
  mode?: "strict" | "free"; // missing when created before modes existed: treated as strict
  rice: { name: string; score: number }[];
  flows: string[];
  createdAt: string;
};

export type DB = {
  projects: Project[];
  requirements: Requirement[];
  stories: Story[];
  nextId: number;
};

let connection: DatabaseSync | undefined;

// One SQLite file. Each entity is stored as a JSON document in its own table, so the
// rest of the code keeps working with plain objects. Each save is one transaction.
function openDb(): DatabaseSync {
  if (connection) return connection;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const c = new DatabaseSync(DB_PATH);
  c.exec(`
    CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requirements (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  connection = c;
  return c;
}

export async function loadDb(): Promise<DB> {
  const c = openDb();
  const meta = c.prepare("SELECT value FROM meta WHERE key = 'nextId'").get() as { value: string } | undefined;
  if (!meta) {
    // First run on this database: import the old JSON file if there is one
    try {
      const legacy = JSON.parse(await readFile(LEGACY_JSON_PATH, "utf8")) as Partial<DB>;
      const db: DB = { projects: legacy.projects ?? [], requirements: legacy.requirements ?? [], stories: legacy.stories ?? [], nextId: legacy.nextId ?? 1 };
      await saveDb(db);
      return db;
    } catch {
      return { projects: [], requirements: [], stories: [], nextId: 1 };
    }
  }
  const rows = <T>(table: string): T[] =>
    (c.prepare(`SELECT data FROM ${table} ORDER BY id`).all() as { data: string }[]).map((r) => JSON.parse(r.data) as T);
  return { projects: rows<Project>("projects"), requirements: rows<Requirement>("requirements"), stories: rows<Story>("stories"), nextId: Number(meta.value) };
}

export async function saveDb(db: DB): Promise<void> {
  const c = openDb();
  c.exec("BEGIN");
  try {
    c.exec("DELETE FROM projects; DELETE FROM requirements; DELETE FROM stories; DELETE FROM meta;");
    const put = (table: string, items: { id: number }[]) => {
      const stmt = c.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`);
      for (const item of items) stmt.run(item.id, JSON.stringify(item));
    };
    put("projects", db.projects);
    put("requirements", db.requirements);
    put("stories", db.stories);
    c.prepare("INSERT INTO meta (key, value) VALUES ('nextId', ?)").run(String(db.nextId));
    c.exec("COMMIT");
  } catch (err) {
    c.exec("ROLLBACK");
    throw err;
  }
}

// What is still missing to complete the project's current phase
export function missingFor(db: DB, p: Project): string[] {
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
    case "verification": {
      const covered = new Set(stories.flatMap((s) => s.requirementIds ?? []));
      return reqs
        .filter((r) => r.priority === "must")
        .flatMap((r) => [
          ...(r.status !== "done" ? [`unfinished must: "${r.title}" (id ${r.id})`] : []),
          ...(covered.has(r.id) ? [] : [`must without a user story: "${r.title}" (id ${r.id})`]),
        ]);
    }
  }
}
