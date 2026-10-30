// GitHub Issues (REST API). Requirements and stories become issues labelled by type and priority.
// Credentials come from the environment: a token with issues write access, and "owner/repo".
import type { Priority } from "../store.js";
import { TrackerError, type Tracker, type TrackerItem, type TrackerMapping } from "./tracker.js";

const PRIORITY_LABEL: Record<Priority, string> = { must: "priority: must", should: "priority: should", could: "priority: could", wont: "priority: wont" };

// How Yeti items map to GitHub. Pure, so previews work without credentials.
export const githubMapping: TrackerMapping = {
  issueType: (kind) => (kind === "requirement" ? "requirement" : "user-story"),
  priorityName: (priority) => PRIORITY_LABEL[priority],
};

// Keys look like GH-42, so they cannot be confused with Jira keys such as KAN-8
const issueNumber = (key: string): number => {
  const m = /^GH-(\d+)$/.exec(key);
  if (!m) throw new TrackerError(`Not a GitHub issue key: ${key}`);
  return Number(m[1]);
};

class GitHubTracker implements Tracker {
  readonly name = "GitHub Issues";
  constructor(private readonly repo: string, private readonly token: string) {}

  issueType(kind: "requirement" | "story") {
    return githubMapping.issueType(kind);
  }

  priorityName(priority: Priority) {
    return githubMapping.priorityName(priority);
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "yeti-mcp",
    };
  }

  private payload(item: TrackerItem) {
    return { title: item.summary, body: item.description, labels: [item.issueType, ...(item.priority ? [item.priority] : [])] };
  }

  private url(key?: string) {
    return `https://api.github.com/repos/${this.repo}/issues${key ? `/${issueNumber(key)}` : ""}`;
  }

  async create(_projectKey: string, item: TrackerItem) {
    const res = await fetch(this.url(), { method: "POST", headers: this.headers(), body: JSON.stringify(this.payload(item)) });
    if (!res.ok) throw new TrackerError(`GitHub answered ${res.status}`, (await res.text()).slice(0, 500), res.status);
    return `GH-${(await res.json()).number}`;
  }

  async update(key: string, item: TrackerItem) {
    const res = await fetch(this.url(key), { method: "PATCH", headers: this.headers(), body: JSON.stringify(this.payload(item)) });
    if (!res.ok) throw new TrackerError(`GitHub answered ${res.status} updating ${key}`, (await res.text()).slice(0, 500), res.status);
  }

  async isDone(key: string) {
    const res = await fetch(this.url(key), { headers: this.headers() });
    if (!res.ok) throw new TrackerError(`GitHub answered ${res.status} for ${key}`, "", res.status);
    return (await res.json()).state === "closed";
  }
}

// Returns the tracker, or the message to show when the credentials are missing
export function githubTracker(): GitHubTracker | string {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return "Missing GITHUB_REPO (owner/repo) or GITHUB_TOKEN in the environment.";
  return new GitHubTracker(repo, token);
}
