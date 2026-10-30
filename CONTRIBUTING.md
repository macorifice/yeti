# Contributing

Thanks for your interest. Small, focused pull requests are easiest to review.

## Setup

```bash
npm install
npm run build
npm test
```

`npm test` must pass before you open a pull request.

## Adding a tool

1. Register it in `src/index.ts` with `server.registerTool`, with a clear description and a Zod input schema.
2. Keep names and messages in English.
3. Add a check in `test/smoke.mjs` that calls the tool.
4. Update the tools table in `README.md`.

## Changing the phases

Phases are defined in `PHASES` and checked in `missingFor`. If you change the order or the rules, update the README and the test that covers the phase flow.

## Adding a work tracker

Trackers live in `src/integrations/`. Jira is the first one: `jira.ts` implements the `Tracker` interface from `tracker.ts`.

1. Create `src/integrations/<name>.ts` with:
   - a pure mapping (`TrackerMapping`): issue type and priority names, which need no credentials;
   - a class implementing `create`, `update` and `isDone`, which talk to the tracker's API and throw `TrackerError` on failure;
   - a factory that reads its credentials from the environment and returns the message to show when they are missing.
2. Add a branch for it in `trackerFor` in `src/index.ts`.
3. Keep the core unchanged: it decides what to send, skips what was already sent, and handles dry runs.
4. Test the mapping and the missing-credentials message in `test/smoke.mjs`. Do not call a real API in tests.

## Reporting bugs

Open an issue with the tool name, the arguments you sent, and the response you got.
