# Continente MCP add-on for Home Assistant

A Home Assistant add-on that runs the original [`continentept-mcp`](https://www.npmjs.com/package/continentept-mcp)
(installed unchanged from npm, pinned at **0.12.1**) and exposes it as an **MCP server over streamable HTTP** that any
AI agent can use: Claude, an OpenAI agent, n8n, [Cesto](https://github.com/jpch/cesto-ha) or your own scripts.

It holds the Continente account and session, signs in on demand through a browser shown on the add-on page
(noVNC, for the "Não sou um robô" check), and puts **one serial queue** in front of the single Chromium that
`continentept-mcp` drives.

This is an independent project, not affiliated with Continente or with the author of `continentept-mcp`.

## What agents can do

- Every agent token can use the catalogue tools (search, products, labels, favourites, orders read-only) and
  **read and change the cart** (`add_cart_item`, `set_cart_item_quantity`, `remove_cart_item`, `clear_cart`).
- **Checkout and payment are blocked by default.** Any tool whose name looks like checkout, payment, placing an
  order, delivery slots, vouchers, coupons, billing or cards is hidden from `tools/list` and refused. The option
  `allow_checkout` (default **false**) unblocks such tools. `continentept-mcp` 0.12.1 has none, so today the option
  changes nothing.
- Tools that are not in the reviewed contract snapshot (`continente_mcp/server/contract/upstream-tools.json`) are
  never listed or called, whatever the options.
- Every cart change is written to the add-on log with the agent name, e.g.
  `[cart] agent="Cesto" tool=set_cart_item_quantity product=4421406 quantity=2 status=success ms=1830`.

## Install

1. Home Assistant → Settings → Add-ons → Add-on store → ⋮ → Repositories → add
   `https://github.com/jpch/continente-mcp-ha`.
2. Install **Continente MCP** and start it.
3. Open the add-on page (sidebar **Continente MCP**, admins only): save the Continente email and password, then
   **Sign in to Continente** and finish the sign-in in the browser shown on the page.
4. Create one token per agent under **Agent tokens**. The token is shown **once**, on the page only; copy it into
   the agent. Only its SHA-256 hash is stored (`/data/tokens.json`, mode 0600). Revoke a token on the same page.

## Connecting an agent

On the home network: `http://<Home Assistant IP>:8100/mcp`, streamable HTTP, with the header
`Authorization: Bearer cmcp_…`. Example for an MCP client configuration:

```json
{ "mcpServers": { "continente": { "type": "http", "url": "http://homeassistant.local:8100/mcp",
  "headers": { "Authorization": "Bearer cmcp_…" } } } }
```

Away from home, through Home Assistant ingress on the external Home Assistant URL: the request needs a Home
Assistant ingress session (see [docs/remote-access.md](docs/remote-access.md)) and the agent token in the header
`X-Continente-MCP-Token: cmcp_…` (the `Authorization` header may be used by Home Assistant). The endpoint is
`https://<external HA URL>/api/hassio_ingress/<ingress token>/mcp`. Port 8100 should not be forwarded to the
internet.

The server is stateless (no MCP session id) and answers with JSON. `GET /health` reports the version, whether the
Continente session is valid, whether a sign-in is open, the queue length and `allow_checkout`; it has no secrets.

## Queue and priority

`continentept-mcp` drives one Chromium and handles one call at a time, so every call from every agent goes
through one serial queue. Tokens marked **priority** (meant for Cesto) always run before waiting calls of other
agents; a running call is never interrupted. At most 50 calls wait (then `busy`), and each token is limited to
120 calls a minute (`rate_limited`).

## Other add-ons (Cesto)

The add-on maps `/share` and uses `/share/continente-mcp`:

- `endpoint.json`: host name, port and slug, so other add-ons find it. No secret.
- `requests/<name>.json`: another add-on asks for a token. It generates the token itself and writes only the
  SHA-256 hash and a name; the request appears on the add-on page with a fingerprint, and nothing happens until
  an administrator approves it. The token never leaves the requesting add-on.
- `import/`: a one-time hand-off of an existing Continente session and credentials (Cesto before 2.0.0). It is
  imported only when this add-on has no saved account and no session that was ever valid (1.0.2), and deleted
  immediately either way. Cesto 2.0.2 and later delete their own old copy once this add-on reports an account or a
  valid session in `/health`.

## Updates of continentept-mcp

`.github/workflows/upstream-bump.yaml` checks npm daily. When a new `continentept-mcp` release is at least 72 h
old, it compares the new `tools/list` with the reviewed snapshot (read-only job, no install scripts, no browser),
opens a PR that bumps the pinned version, and runs the full build. If no tool was added, removed or changed, it
merges and releases; otherwise the PR waits for a human review.

## Options

| Option | Default | |
|---|---|---|
| `allow_checkout` | `false` | Expose checkout/payment-like tools (none exist in 0.12.1). |
| `log_level` | `info` | |

## Security

See [docs/security-review.md](docs/security-review.md). In short: tokens are random 256-bit values stored as
hashes; the page and admin API are reachable only through Home Assistant ingress by HA administrators; the
password is write-only; tokens, passwords and cookies are never logged.

## Development

```sh
cd continente_mcp/server
npm ci
npm test            # unit, policy and HTTP tests against a fake continentept-mcp
npm run typecheck
npm install -g --ignore-scripts continentept-mcp@0.12.1 && npm run contract:check
```

Licence: MIT.

The add-on options are translated in `continente_mcp/translations/` (`en.yaml`, `pt.yaml`). Dependabot proposes
weekly npm (`continente_mcp/server`, the smoke test) and GitHub Actions updates; `continentept-mcp` itself is only
updated by `upstream-bump.yaml`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for every release; each GitHub release carries the notes of its version.

## Prebuilt images

The add-on is built locally by Home Assistant (the first install takes a few minutes). To publish prebuilt images to GHCR instead, make sure the `ghcr.io/jpch/{arch}-continente-mcp` packages grant this repository write access (package settings, "Manage Actions access"), set the repository variable `PUBLISH_IMAGES=true`, and add `image: ghcr.io/jpch/{arch}-continente-mcp` back to `continente_mcp/config.yaml`.
