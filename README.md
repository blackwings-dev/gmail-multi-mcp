<div align="center">

# gmail-multi-mcp

**An MCP server that connects your AI assistant to *several* Gmail accounts at once.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.12-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](./tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2.svg)](https://modelcontextprotocol.io)

</div>

---

## Why this exists

**The official Gmail connector handles one account.** If your work lives in
`you@company.com`, your invoices arrive at `billing@company.com` and your life happens in
`you@gmail.com`, you end up switching connectors — or simply cannot ask a question that
spans two of them.

This server makes the account a first-class parameter, and then goes one step further:

```
"Any unread invoices this week?"

  → search_emails { query: "is:unread invoice newer_than:7d" }
  → searches work@, billing@ and personal@ in parallel
  → one merged, date-sorted answer
```

Omit the account and it searches **every mailbox you have connected**. One Google Cloud
project, as many accounts as you want.

---

## Features

- **Multi-account by design.** Add as many Gmail accounts as you like; each keeps its own
  credentials.
- **Cross-account search.** `search_emails` without an `account` queries every mailbox in
  parallel and merges the results into one date-sorted list.
- **Degrades instead of failing.** If one account's token is revoked, the others still
  return — and the broken one is reported in a `failures` field rather than silently
  dropped.
- **Aliases.** Call an account `work` or `personal` instead of typing the full address.
- **Standard OAuth, no password ever.** Consent happens in your browser, on Google's own
  screen, through a CSRF-protected loopback callback.
- **Tokens stay on your machine**, in your home directory, `0600` on Unix — never in the
  repository, never in the MCP client configuration.
- **Automatic token refresh**, written back to disk so a restart does not re-refresh.
- **Nine tools:** read, search, draft, reply, send and label.
- **Cannot permanently delete anything.** The single scope it requests does not allow it,
  and no tool exposes it.
- **Strict TypeScript**, no `any`, and a dependency list you can read in one glance.

---

## Prerequisites

| | |
|---|---|
| **Node.js** | **≥ 20.12** — see the note below |
| **Google Cloud** | A free account. No billing needed for personal Gmail API use. |
| **An MCP client** | Claude Code, Claude Desktop, or anything that speaks MCP over stdio. |

> **Why 20.12 and not 18.** The server loads a local `.env` with Node's built-in
> `process.loadEnvFile()`, which landed in **20.12** (and 21.7). On Node 18 that file would
> be ignored *silently*, and you would get a confusing "no credentials" error with a
> perfectly good `.env` sitting right there. The floor is real, not cautious.

---

## Installation

```bash
git clone https://github.com/blackwings-dev/gmail-multi-mcp.git
cd gmail-multi-mcp
npm install
npm run build
```

That produces `dist/index.js`, which is what your MCP client will run. Check it:

```bash
node dist/index.js --version
```

---

## Google Cloud setup

You do this **once**, no matter how many Gmail accounts you connect. About five minutes.

### 1. Create a project

Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project —
call it whatever you like, e.g. `gmail-mcp`.

### 2. Enable the Gmail API

Direct link, with your new project selected:

**<https://console.cloud.google.com/apis/library/gmail.googleapis.com>**

Press **Enable**. Nothing else on that page matters.

### 3. Configure the consent screen

In the sidebar this now lives under **Google Auth Platform**; older projects show it as
*APIs & Services → OAuth consent screen*.

| Field | What to put |
|---|---|
| **App name** | Anything, e.g. `Gmail MCP`. Only you will see it. |
| **User support email** | Your own address. |
| **Audience / User type** | **External** |
| **Developer contact** | Your own address again. |

Then, under **Audience → Test users**, press **Add users** and add **every Gmail address
you intend to connect**.

> ⚠️ **This step is not optional.** While the app is in *Testing*, an account that is not
> listed as a test user **cannot grant consent** — Google shows an "access blocked" screen
> that does not explain why.

### 4. Create the OAuth client

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

| Field | Value |
|---|---|
| **Application type** | **Desktop app** ← this exact type |
| **Name** | Anything, e.g. `gmail-multi-mcp` |

Copy the **Client ID** and **Client secret** from the dialog that appears.

> **Why "Desktop app" specifically.** That client type accepts any loopback port as a
> redirect URI. The setup flow opens a throwaway server on a random free port and hands
> that URL to Google, so you never register redirect URIs by hand — which is exactly what
> lets a single project serve any number of accounts.

---

## Configuring the server

### 1. Credentials

```bash
cp .env.example .env
```

```dotenv
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
```

`.env` is git-ignored. You can also skip this file entirely — `npm run setup` will ask for
the credentials and store them in `~/.gmail-multi-mcp/config.json`. If both exist, the
environment wins.

### 2. Connect your accounts

```bash
npm run setup
```

```
  gmail-multi-mcp
  One Google Cloud project. As many Gmail accounts as you need.

  config  C:\Users\you\.gmail-multi-mcp\config.json
  tokens  C:\Users\you\.gmail-multi-mcp\tokens

✔ OAuth credentials found in the environment.

What now?
─────────
  1  Add a Gmail account
  2  List accounts
  3  Remove an account
  4  Show MCP client configuration
  q  Quit
```

Choose **1**. A browser opens, you sign in, you grant access, and the tab says *"Account
connected"*. The CLI then asks for an optional **alias** — `work`, `personal`, `billing` —
which you can use instead of the full address from then on.

> ### ⚠️ Adding a second account
>
> **Sign out of Google first, or use a private/incognito window.**
>
> Otherwise the browser reuses the session you already have, Google skips the account
> chooser, and you connect the *same* mailbox twice without noticing.

Repeat for each account, then check the result with option **2**.

### 3. Register the server with Claude Code

The supported way — this edits Claude Code's user configuration correctly instead of by
hand:

```bash
claude mcp add gmail-multi-mcp \
  --scope user \
  -e GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=GOCSPX-your-secret \
  -- node /absolute/path/to/gmail-multi-mcp/dist/index.js
```

On Windows the path looks like `D:\Dev\gmail-multi-mcp\dist\index.js`.

Verify:

```bash
claude mcp list
# gmail-multi-mcp: node .../dist/index.js - ✔ Connected
```

Then **restart Claude Code** so it picks the server up.

<details>
<summary><b>Claude Desktop, or any other MCP client</b></summary>

Add this to your client's configuration file (`claude_desktop_config.json` for Claude
Desktop):

```json
{
  "mcpServers": {
    "gmail-multi-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-multi-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-your-secret"
      }
    }
  }
}
```

The `env` block is optional if the credentials are already in
`~/.gmail-multi-mcp/config.json`. Account tokens are always read from there — they never go
in the client configuration.

</details>

---

## Usage

Once connected, just ask in natural language. A few that exercise different tools:

| What you say | What happens |
|---|---|
| *"Any unread invoices this week?"* | `search_emails` across **all** accounts, merged |
| *"Read the last email from ana@client.com in my work account"* | `search_emails` + `read_message` |
| *"Summarise the thread about the Q3 budget"* | `read_thread` — the whole conversation |
| *"Draft a reply to that thread from personal@gmail.com saying I'll confirm on Monday"* | `create_draft`, nothing is sent |
| *"Reply to Marta confirming Thursday at 10"* | `reply` — stays in-thread, and **sends** |
| *"Label that message as Facturas and mark it read"* | `label_message` |
| *"Which accounts do I have connected?"* | `list_accounts` |

Two habits worth having:

- Ask for a **draft** unless you really want it sent. `reply` and `send_message` go out
  immediately and there is no undo.
- Name the account (*"in my work account"*) when you mean one; leave it out when you want
  all of them.

---

## MCP tools

| Tool | Description | Parameters |
|---|---|---|
| `list_accounts` | Configured accounts and whether each is usable | `probe?` — contact Gmail to confirm (slower, catches revoked tokens) |
| `search_emails` | Gmail query syntax. **Without `account`, searches every mailbox** | `query`, `account?`, `max_results?` (1–100, default 20) |
| `read_thread` | A full conversation, every message in order | `thread_id`, `account` |
| `read_message` | One message: decoded body plus attachment metadata | `message_id`, `account` |
| `create_draft` | Saves a draft **without sending** | `account`, `to[]`, `subject`, `body`, `cc?`, `bcc?`, `is_html?`, `thread_id?` |
| `reply` | Replies in-thread — handles `Re:`, `In-Reply-To` and `References`. **Sends.** | `account`, `message_id`, `body`, `reply_all?`, `is_html?` |
| `send_message` | Composes and sends a new email. **No undo.** | `account`, `to[]`, `subject`, `body`, `cc?`, `bcc?`, `is_html?`, `thread_id?` |
| `list_labels` | Labels of an account, with their ids | `account` |
| `label_message` | Adds and/or removes labels; accepts names or ids | `account`, `message_id`, `add_labels?`, `remove_labels?` |

**`account` accepts an email address or an alias.** Both `"work"` and `"work@company.com"`
resolve to the same mailbox.

Useful system labels for `label_message`: `UNREAD` (remove it to mark as read), `STARRED`,
`IMPORTANT`, `SPAM`, `TRASH`. Adding `TRASH` moves a message to the bin, where it is
recoverable — **nothing here deletes permanently**.

Attachment *metadata* is returned (filename, MIME type, size); attachment **contents** are
not downloaded.

---

## Troubleshooting

### `HTTP ERROR 431 (Request Header Fields Too Large)` on the callback

Fixed in current versions — if you see it, you are on an old build. The cause is worth
knowing, because it is not obvious:

The redirect used to go to `localhost`, which is a **shared cookie origin**. Every dev
server you have ever run on any `localhost` port can leave cookies there, and the browser
sends *all of them* to the OAuth callback. Past roughly 16 KB that exceeds Node's default
header limit — and it fails **after** Google has already granted consent, so the
authorisation code is lost.

The redirect now targets `127.0.0.1`, which does not receive `localhost` cookies, and the
callback server accepts 64 KB of headers. If it somehow still happens, clear cookies for
`127.0.0.1` and retry.

### Accounts stop working after 7 days

Your OAuth consent screen is still in **Testing**, and Google expires refresh tokens for
apps in that state after seven days.

You have two options, and neither is free:

- **Stay in Testing** and re-run `npm run setup` once a week.
- **Publish the app** (*Google Auth Platform → Audience → Publish app*). Refresh tokens
  stop expiring. In exchange, an app that has not been through Google's review shows an
  **"unverified app" warning screen** on every consent, and is capped at a limited number
  of users — enough for your own mailboxes, not for distributing this to a team.

`gmail.modify` is a **restricted** scope, the category Google reviews most closely, and
that review policy changes. Check the current requirements on the consent screen itself
before assuming publishing will be waved through.

### `Unknown account "..."`

The reference did not match any configured email or alias.

```bash
npm run setup      # option 2 — List accounts
```

Or ask your assistant to call `list_accounts`.

### `Google did not return a refresh token`

Google issues one only on **first** consent. Revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions), then
authorise again.

### `Access denied by Gmail` (HTTP 403)

Almost always one of two things: the **Gmail API is not enabled** on the project, or the
account is **not listed as a test user** on the consent screen.

### You connected the same mailbox twice

The browser reused an existing Google session. Remove the duplicate with option **3**, then
add the other account from a private window.

### Your MCP client shows a JSON parse error and disconnects

Something wrote to stdout. On the stdio transport, **stdout is the protocol**. If you are
modifying this server, every diagnostic must go to stderr — never `console.log`.

### A cross-account search returns fewer results than expected

Look at the `failures` field of the response. An account whose token was revoked is
reported there rather than silently skipped.

---

## Security

- **Tokens never leave your machine.** They live in `~/.gmail-multi-mcp/tokens/`, one file
  per account, `chmod 0600` on Unix. Nothing is sent anywhere except Google.
- **Nothing sensitive is in the repository.** `.gitignore` covers `.env` and every `.env.*`
  except the example.
- **One scope, deliberately limited:** `https://www.googleapis.com/auth/gmail.modify` —
  read, draft, send, label. It **cannot permanently delete**, and no tool offers it.
- **CSRF-protected callback.** A random `state` is generated per flow and compared in
  constant time; a callback that does not match is rejected.
- **Loopback only.** The callback server binds `127.0.0.1`, on an ephemeral port, and shuts
  down as soon as the code arrives.
- **Header injection blocked.** CR/LF is stripped from every outgoing header value, so a
  crafted subject or recipient cannot inject extra headers.
- **About the client secret:** for **Desktop app** clients Google does not treat it as
  confidential — an installed application cannot keep a secret, which is why this flow is
  designed not to depend on one. Keep it out of your repository anyway, and rotate it if
  you ever move to a web client type.
- **Removing an account** deletes the local token but does **not** revoke Google's grant.
  To revoke it fully, visit
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## How it works

```
MCP client ──stdio──▶ src/index.ts ──▶ src/server.ts        9 tools, zod-validated
                                          │
                       ┌──────────────────┴───────────────────┐
                       ▼                                      ▼
              src/gmail/search.ts                    src/gmail/client.ts
              parallel search,                       MIME parse + build,
              per-account failure isolation          error mapping
                       └──────────────────┬───────────────────┘
                                          ▼
                                  src/auth/oauth.ts
                          loopback consent, automatic refresh
                                          │
                                          ▼
                              src/auth/token-store.ts
                                ~/.gmail-multi-mcp/
```

| Path | Contents |
|---|---|
| `~/.gmail-multi-mcp/config.json` | OAuth client (if not in the environment) and the account list |
| `~/.gmail-multi-mcp/tokens/<email>.json` | One refresh token per account |

**Auto-refresh** is handled by Google's auth client: an expired access token is renewed
transparently, and a `tokens` listener writes the new one back to disk so the next process
start does not have to refresh again.

---

## Development

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # no emit
npm run dev          # run the server from source with tsx
npm run setup        # run the setup CLI from source
```

Smoke-test the server without an MCP client:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/index.js
```

### Layout

```
src/
  index.ts            entry point: server by default, `setup` for the CLI
  server.ts           MCP server and the nine tool definitions
  auth/
    oauth.ts          consent flow, loopback callback, automatic refresh
    token-store.ts    config.json and per-account token files
  gmail/
    client.ts         authenticated clients, MIME parsing and building
    search.ts         single- and multi-account search
    types.ts          domain types and the error taxonomy
  cli/
    setup.ts          interactive setup (chalk)
```

TypeScript runs with `strict` plus `noUncheckedIndexedAccess`, `noImplicitReturns`,
`noUnusedLocals` and `verbatimModuleSyntax`. There is no `any` in the source.

---

## Contributing

Issues and pull requests are welcome.

1. Fork the repository and create a branch: `git checkout -b feature/what-it-does`.
2. Make your change. `npm run typecheck` and `npm run build` must both pass.
3. Smoke-test the server as shown above.
4. Open a pull request describing **what changed, why, and how you verified it**.

Please keep the three rules that hold the design together:

- **Nothing writes to stdout** outside `src/cli/` and the `--help` / `--version` paths.
  Stdout is the MCP transport.
- **No `any`.** Google's types are noisy; convert them at the boundary in
  `src/gmail/client.ts` and keep the rest of the codebase on the types in
  `src/gmail/types.ts`.
- **No tool that deletes permanently.** The scope does not allow it, and that is on
  purpose.

Good first contributions: attachment download, `mark_read` / `archive` convenience tools,
an unread-count summary across accounts, or Gmail push notifications.

### Reporting a security issue

Please do **not** open a public issue. Contact the maintainers privately first.

---

## License

[MIT](./LICENSE) — do what you like, no warranty.
