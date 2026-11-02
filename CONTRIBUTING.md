# Contributing

Thanks for taking a look. This is a small project; keep changes focused and easy to review.

## Development

```bash
npm install
npm start            # http://127.0.0.1:8686

# In a second terminal, with the server running:
npm run test:prompt      # prompt builder unit tests (no network)
npm run test:openai      # OpenAI contract (needs the server + upstream)
npm run test:sandbox     # sandbox escape attempts (no network)
npm run test:finish      # finish-shape handling in the sandbox
npm run test:agent       # end-to-end agent scenarios (needs upstream)
npm run test:smoke       # proxy + chat end-to-end (needs upstream)
```

Network-dependent suites hit the live upstream service, so they can fail for reasons unrelated to your
change. Note in the PR which ones you ran.

## Ground rules

- **No secrets, no personal data** in code, tests, or fixtures.
- **Keep authority explicit.** Two separate things live here and must not be conflated:
  - `tools` → executed by the *client*. This server only negotiates and returns `tool_calls`.
  - `agent: true` → executed by *this server* inside the sandbox.
- **The sandbox is a boundary.** Do not add capabilities to `src/runner.mjs` beyond `callTool`,
  `console` and `final_answer`. New capabilities belong in `src/tools.mjs` (parent side), where the
  path/URL/timeout limits live.
- **Fail loudly, degrade quietly.** Upstream quirks should be handled in `src/chaoxing.mjs` /
  `src/agent.mjs` with an explicit reason, not by silently returning empty answers.

## Adding a local tool

1. Append an entry to `tools` in `src/tools.mjs`:
   ```js
   {
     name: 'my_tool',
     description: '一句话说明它做什么（会进提示词，越短越好）',
     parameters: { type: 'object', properties: { /* ... */ }, required: [] },
     async run(args) { /* return JSON-serializable value */ },
   }
   ```
2. Constrain it: paths through `withinRoot()`, URLs through `assertPublicHost()`, subprocesses through
   `execFile` with a timeout.
3. It is automatically visible to `/v1/agent/tools`, the bundled UI and the agent loop.

## Reporting issues

Include: what you ran, what you expected, what happened, Node version, and the relevant server log lines.
Protocol-level oddities are easiest to debug with `node test/debug-flow.mjs "你的问题"`, which prints every
upstream frame.

## Pull requests

- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`).
- Describe the observable behaviour change and which suites you ran.
- If you change the upstream protocol handling, update [ANALYSIS.md](ANALYSIS.md) in the same PR.
