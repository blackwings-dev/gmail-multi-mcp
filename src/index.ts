#!/usr/bin/env node
/**
 * Entry point.
 *
 *   gmail-multi-mcp          → run the MCP server on stdio (what a client spawns)
 *   gmail-multi-mcp setup    → interactive account setup in a terminal
 *
 * The default is the server, not the CLI: an MCP client launches this binary
 * with no arguments and expects JSON-RPC on stdout immediately.
 */

import { runServer, SERVER_NAME, SERVER_VERSION } from './server.js';

/**
 * Load a local `.env` if there is one, before anything reads `process.env`.
 *
 * Node does NOT do this on its own, so without this call the documented
 * "copy .env.example to .env" path silently did nothing and credentials had to
 * come from config.json or a manually exported variable.
 *
 * `process.loadEnvFile` is built in since Node 20.12 — no dotenv dependency.
 * A missing file is the normal case, not an error.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    /* No .env, or a Node too old for it. Both are fine. */
  }
}

function printUsage(): void {
  // stdout is safe here: this path never becomes an MCP transport.
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}\n\n` +
      `Usage:\n` +
      `  gmail-multi-mcp           Run the MCP server on stdio\n` +
      `  gmail-multi-mcp setup     Add, list or remove Gmail accounts\n` +
      `  gmail-multi-mcp --help    Show this message\n` +
      `  gmail-multi-mcp --version Print the version\n\n` +
      `Docs: https://github.com/<your-username>/gmail-multi-mcp\n`,
  );
}

async function main(): Promise<void> {
  loadDotEnv();
  const command = process.argv[2];

  switch (command) {
    case 'setup': {
      // Imported lazily so the server path never pays for chalk, readline and open.
      const { runSetup } = await import('./cli/setup.js');
      await runSetup();
      return;
    }
    case '--help':
    case '-h':
    case 'help':
      printUsage();
      return;
    case '--version':
    case '-v':
      process.stdout.write(`${SERVER_VERSION}\n`);
      return;
    case undefined:
      await runServer();
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[${SERVER_NAME}] fatal: ${detail}\n`);
  process.exit(1);
});
