// Jira Cloud (REST API v3). Credentials come from the environment, never from the repository.
import type { Priority } from "../store.js";
import { TrackerError, type Tracker, type TrackerItem, type TrackerMapping } from "./tracker.js";

// MoSCoW priority mapped to Jira's default priority names
const PRIORITY: Record<Priority, string> = { must: "Highest", should: "High", could: "Medium", wont: "Low" };

// Jira needs descriptions as a document: one paragraph per line
const adfDoc = (block: string) => ({
  type: "doc",
  version: 1,
  content: (block || " ").split("\n").map((line) => ({ type: "paragraph", content: [{ type: "text", text: line || " " }] })),
});

// How Yeti items map to Jira. Pure: it needs no credentials, so previews work without them.
export const jiraMapping: TrackerMapping = {
  issueType: (kind) => (kind === "requirement" ? "Task" : "Story"),
  priorityName: (priority) => PRIORITY[priority],
};

class JiraTracker implements Tracker {
  readonly name = "Jira";
  constructor(private readonly site: string, private readonly auth: string) {}

  issueType(kind: "requirement" | "story") {
    return jiraMapping.issueType(kind);
  }

  priorityName(priority: Priority) {
    return jiraMapping.priorityName(priority);
  }

  private headers() {
    return { Authorization: this.auth, "Content-Type": "application/json", Accept: "application/json" };
  }

  async create(projectKey: string, item: TrackerItem) {
    const res = await fetch(`${this.site}/rest/api/3/issue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: { name: item.issueType },
          summary: item.summary,
          description: adfDoc(item.description),
          ...(item.priority ? { priority: { name: item.priority } } : {}),
        },
      }),
    });
    if (!res.ok) throw new TrackerError(`Jira answered ${res.status}`, (await res.text()).slice(0, 500), res.status);
    return (await res.json()).key as string;
  }

  async update(key: string, item: TrackerItem) {
    const res = await fetch(`${this.site}/rest/api/3/issue/${key}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        fields: {
          summary: item.summary,
          description: adfDoc(item.description),
          ...(item.priority ? { priority: { name: item.priority } } : {}),
        },
      }),
    });
    if (!res.ok) throw new TrackerError(`Jira answered ${res.status} updating ${key}`, (await res.text()).slice(0, 500), res.status);
  }

  async isDone(key: string) {
    const res = await fetch(`${this.site}/rest/api/3/issue/${key}?fields=status`, {
      headers: { Authorization: this.auth, Accept: "application/json" },
    });
    if (!res.ok) throw new TrackerError(`Jira answered ${res.status} for ${key}`, "", res.status);
    const body = await res.json();
    return body.fields.status.statusCategory.key === "done";
  }
}

// Returns the tracker, or the message to show when the credentials are missing
export function jiraTracker(): JiraTracker | string {
  const site = process.env.JIRA_SITE;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!site || !email || !token) return "Missing JIRA_SITE, JIRA_EMAIL or JIRA_API_TOKEN in the environment.";
  return new JiraTracker(site, "Basic " + Buffer.from(`${email}:${token}`).toString("base64"));
}
