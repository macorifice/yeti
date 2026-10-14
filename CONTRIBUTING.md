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

## Reporting bugs

Open an issue with the tool name, the arguments you sent, and the response you got.
