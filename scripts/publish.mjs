// Publish this project to GitHub.
//
// Run AFTER authenticating once (either command works):
//   git credential-manager github login      # opens a browser
//   gh auth login
//
// Then: node scripts/publish.mjs
// It creates the repository if missing, wires the remote, and pushes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = process.env.GH_OWNER ?? 'Zelda896';
const REPO = process.env.GH_REPO ?? 'chaoxing-openai-proxy';
const DESCRIPTION =
  '把超星 AI 馆员变成标准 OpenAI 兼容 API + 可调本地工具的 Agent（代码即动作 + 沙箱）. Turn the Chaoxing AI librarian into an OpenAI-compatible API and a sandboxed tool-calling agent.';

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

if (!fs.existsSync('.git')) {
  console.error('no .git directory here; run this from the project root');
  process.exit(1);
}

// 1. Recover a credential. Environment tokens win; the git helper is queried non-interactively so this
// script never blocks waiting for a browser prompt.
let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || '';
if (!token) {
  const fill = await run('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  token = /password=(.+)/.exec(fill.stdout)?.[1]?.trim() ?? '';
}
if (!token) {
  console.error('No GitHub credential available.\n');
  console.error('Authenticate once, then re-run this script:\n');
  console.error('  git credential-manager github login      # opens a browser\n');
  console.error('  gh auth login\n');
  console.error('Or pass a token inline:\n');
  console.error('  GITHUB_TOKEN=<your PAT> node scripts/publish.mjs\n');
  process.exit(1);
}

const api = async (method, endpoint, body) => {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'chaoxing-openai-proxy-publisher',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
};

// 2. Verify the token and identify the account.
const me = await api('GET', '/user');
if (me.status !== 200) {
  console.error(`Credential rejected by the API (HTTP ${me.status}). Re-authenticate and retry.`);
  process.exit(1);
}
const login = me.body.login;
console.log(`authenticated as ${login}`);

// 3. Create the repository (idempotent: an existing repo is fine).
const full = `${login}/${REPO}`;
let created = false;
const exists = await api('GET', `/repos/${full}`);
if (exists.status === 200) {
  console.log(`repository ${full} already exists`);
} else {
  const made = await api('POST', '/user/repos', {
    name: REPO,
    description: DESCRIPTION,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
  });
  if (made.status !== 201) {
    console.error(`could not create repository: HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 300)}`);
    process.exit(1);
  }
  created = true;
  console.log(`created ${full} (public)`);
}

// 4. Apply topics so the repo is discoverable.
await api('PUT', `/repos/${full}/topics`, {
  names: ['openai-api', 'openai-compatible', 'llm-proxy', 'tool-calling', 'agent', 'code-agent', 'chaoxing', 'nodejs'],
});

// 5. Wire the remote and push.
const remoteUrl = `https://github.com/${full}.git`;
const remotes = await run('git', ['remote']);
if (!remotes.stdout.split('\n').map((line) => line.trim()).includes('origin')) {
  const added = await run('git', ['remote', 'add', 'origin', remoteUrl]);
  if (added.code !== 0) {
    console.error('could not add remote:', added.stderr.trim());
    process.exit(1);
  }
  console.log(`remote origin -> ${remoteUrl}`);
} else {
  await run('git', ['remote', 'set-url', 'origin', remoteUrl]);
  console.log(`remote origin updated -> ${remoteUrl}`);
}

const push = await run('git', ['push', '-u', 'origin', 'main']);
if (push.code !== 0) {
  console.error('push failed:\n' + (push.stderr || push.stdout).trim());
  process.exit(1);
}
console.log(push.stderr.trim() || push.stdout.trim());

console.log(`\nDone: https://github.com/${full}${created ? ' (newly created)' : ''}`);
