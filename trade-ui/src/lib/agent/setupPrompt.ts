import { CONNECTOR_PACKAGE, SETUP_COMMAND } from './agent.svelte';

export const CLIENTS = { claude: 'Claude Code', codex: 'Codex', other: 'Other MCP client' } as const;
export type Client = keyof typeof CLIENTS;
const SESSION_CLIENT = { claude: 'claude-code', codex: 'codex', other: 'other' } as const;
export const command = 'npx';
export const args = ['--yes', '--package', CONNECTOR_PACKAGE, 'getliq'];
export const launch = `npx --yes --package "${CONNECTOR_PACKAGE}" getliq`;

/** What a local AI is asked to do to connect itself: run setup, register getliq, pair this browser. It never passes --answer. */
export function setupPrompt(client: Client, name = 'getliq') {
  const addStep =
    client === 'claude'
      ? `Run: claude mcp get ${name}. If it exists with an http URL (the old hosted server), run claude mcp remove ${name}. Then run: claude mcp add --scope user ${name} -- ${launch}`
      : client === 'codex'
        ? `Edit ~/.codex/config.toml. Replace the launch settings in [mcp_servers.${name}], including any old URL or repository-path launcher, with:\n   [mcp_servers.${name}]\n   command = "${command}"\n   args = ${JSON.stringify(args)}\n   startup_timeout_sec = 60\n   required = true\n   Leave the rest of the file unchanged.`
        : `Replace any existing MCP server named ${name} with a stdio server: command ${command}, args ${JSON.stringify(args)}. Keep other servers.`;
  return `Connect ${CLIENTS[client]} to the getliq trading mentor. It runs on this computer: a small MCP server over stdio that keeps its data in ~/.getliq/getliq.db and talks to the browser only on 127.0.0.1:28657. Nothing is stored in the cloud.

Connection
- Setup command: ${SETUP_COMMAND} --no-answer
- Server name: ${client === 'other' ? name : 'getliq'}
- Transport: stdio
- Needs Node 24.22.1+ (24 LTS, recommended) or 26.12.1+ and npm/npx. The package is a pinned revision of the public read-only getliq gist: only the compiled local server and its launcher; npm installs its runtime dependencies. No repository clone or Git history is needed. Do not request, clone, inspect or open the trading repository, source files, private keys, browser tokens or existing database. Replace an old repository-path or downloaded-archive launcher with this pinned gist package. If Node needs an update, install the pinned LTS release using the existing version manager. If node is not on the client's PATH, use its absolute path.
- No API key, wallet, signature or trading key.

Steps
1. Run the setup command in a terminal on this computer, in the background or with a timeout of at least 10 minutes. It installs getliq under ~/.getliq, registers it with Claude Code and Codex, starts it at login, opens this site to pair this browser and exits once it pairs. If it says Node is too old, show me its install hint and stop.
2. ${client === 'other' ? `Add the stdio server it printed for other MCP clients, named ${name}, with exactly that command and args. If it printed none: ${addStep}` : `If setup did not print ✓ for ${CLIENTS[client]}: ${addStep}`}
3. Check the configured server with the client’s MCP status command. If the tools are already available, continue immediately. Use the client’s supported MCP reconnect/reload command when available. If a full client restart is required, explain that once and retain the completed setup; do not repeat installation or ask for paths. After restart, continue from whoami. If tools are still missing, inspect the MCP startup error instead of repeating restart instructions.
4. Call whoami (its id is a private workspace, not a wallet). If setup did not print "✓ Browser paired", call pair_browser and show me the link to open on this computer; never open it yourself. Chrome or Edge may ask to allow access to apps on this device.
5. Call client_session with {"client":"${SESSION_CLIENT[client]}","status":"active"}. Call chart_context; if it reports unavailable, tell me I can turn on "Share chart context" in Co-pilot (optional).
6. Read getliq://guide/mentor and confirm the connection is ready. Do not ask for repository paths or start a lesson during setup.

Answers on screen stay off: to have Claude Code answer questions typed on the chart, I run the setup command with --answer myself. Never pass --answer.

Rules: never place orders, change positions, ask for wallet signatures or secrets, or set up recurring tasks. If a step fails, stop and report the exact error.`;
}
