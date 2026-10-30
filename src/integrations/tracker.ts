// An external work tracker that Yeti can send items to. The core decides what to send, when,
// and what to skip; a tracker only talks to its own system. Jira is the first implementation.
import type { Priority } from "../store.js";

export type TrackerItem = {
  issueType: string;
  summary: string;
  description: string;
  // Priority already translated to the tracker's own names (see priorityName)
  priority?: string;
};

// A failed call to the tracker, with the HTTP status and the first part of the response body
export class TrackerError extends Error {
  constructor(message: string, public readonly detail = "", public readonly status?: number) {
    super(message);
  }
}

// Pure mapping from Yeti items to a tracker's names
export type TrackerMapping = {
  issueType(kind: "requirement" | "story"): string;
  priorityName(priority: Priority): string;
};

export interface Tracker extends TrackerMapping {
  readonly name: string;
  // Creates an item in a project and returns its key
  create(projectKey: string, item: TrackerItem): Promise<string>;
  // Refreshes an item that was created before
  update(key: string, item: TrackerItem): Promise<void>;
  // True when the item counts as finished on the tracker side
  isDone(key: string): Promise<boolean>;
}
