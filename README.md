# Continente MCP add-on for Home Assistant

A Home Assistant add-on that runs the original [`continentept-mcp`](https://www.npmjs.com/package/continentept-mcp)
(installed unchanged from npm, version pinned in [`continente_mcp/Dockerfile`](continente_mcp/Dockerfile)) and
exposes it as an **MCP server over streamable HTTP** for any AI agent: Claude, an OpenAI agent, n8n,
[Cesto](https://github.com/jpch/cesto-ha) or your own scripts.

It holds the Continente account and session, signs in through a browser shown on the add-on page (noVNC, for the
"Não sou um robô" check), and puts one serial queue in front of the single Chromium that `continentept-mcp` drives.

Independent project, not affiliated with Continente or with the author of `continentept-mcp`.

## What agents can do

- Use the catalogue tools (search, products, labels, favourites, orders read-only) and **read and change the cart**
  (`add_cart_item`, `set_cart_item_quantity`, `remove_cart_item`, `clear_cart`).
- **Never check out or pay by default.** Tools whose names look like checkout, payment, placing an order, delivery
  slots, vouchers, coupons, billing or cards are hidden from `tools/list` and refused.
- Only tools in the reviewed contract snapshot (`continente_mcp/server/contract/upstream-tools.json`) are ever
  listed or called.
- Every cart change is logged with the agent name, e.g.
  `[cart] agent="Cesto" tool=set_cart_item_quantity product=4421406 quantity=2 status=success ms=1830`.

## Install

1. Home Assistant → Settings → Add-ons → Add-on store → ⋮ → Repositories → add
   `https://github.com/jpch/continente-mcp-ha`.
2. Install **Continente MCP** and start it. The first install builds the image locally and takes a few minutes.
3. Open the add-on page (sidebar **Continente MCP**, admins only), save the Continente email and password, then
   **Sign in to Continente** and finish the sign-in in the browser shown on the page.
4. Under **Agent tokens**, create one token per agent. It is shown **once**; copy it into the agent. Revoke tokens
   on the same page.

## Connect an agent

On the home network: `http://<home-assistant-address>:8100/mcp`, streamable HTTP, header
`Authorization: Bearer cmcp_…`:

```json
{ "mcpServers": { "continente": { "type": "http", "url": "http://<home-assistant-address>:8100/mcp",
  "headers": { "Authorization": "Bearer cmcp_…" } } } }
```

Away from home, go through Home Assistant ingress on the external Home Assistant URL with an ingress session and the
header `X-Continente-MCP-Token: cmcp_…`: see [docs/remote-access.md](docs/remote-access.md). Do not forward port 8100.

The server is stateless (no MCP session id) and answers with JSON. `GET /health` (no secrets) reports the version,
the add-on slug, whether the Continente session is valid, whether a sign-in is open, the queue length and
`allow_checkout`.

## Queue and priority

Every call from every agent goes through one serial queue. Tokens marked **priority** (for Cesto) run before waiting
calls of other agents; a running call is never interrupted. At most 50 calls wait (then `busy`), and each token is
limited to 120 calls a minute (`rate_limited`).

## Other add-ons

The add-on maps `/share` and uses `/share/continente-mcp`:

- `endpoint.json`: host name, port and slug, so other add-ons can find it. No secret.
- `requests/<name>.json`: another add-on asks for a token by writing only its SHA-256 hash and a name. The request
  appears on the add-on page with a fingerprint and does nothing until an administrator approves it.
- `import/`: a one-time session hand-off from another add-on, accepted only while this add-on has no saved account
  and has never had a valid session, and deleted immediately either way.

## Options

| Option | Default | |
|---|---|---|
| `allow_checkout` | `false` | Expose checkout/payment-like tools, if a reviewed `continentept-mcp` version ever offers one. |
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. |

## Security

- Tokens are random 256-bit values; only their SHA-256 hashes are stored (`/data/tokens.json`, mode 0600).
- The page and admin API answer only through Home Assistant ingress, for Home Assistant administrators.
- The Continente password is write-only; tokens, passwords and cookies are never logged.
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md) and the
  [security review](docs/security-review.md).

## Updates of continentept-mcp

`.github/workflows/upstream-bump.yaml` checks npm daily. When a new release is at least 72 h old, it compares its
`tools/list` with the reviewed snapshot, opens a PR that bumps the pin and runs the full build. It merges and
releases only if no tool changed; otherwise the PR waits for a human review. Dependabot proposes weekly npm and
GitHub Actions updates.

## Development

```sh
cd continente_mcp/server
npm ci
npm test            # unit, policy and HTTP tests against a fake continentept-mcp
npm run typecheck
npm install -g --ignore-scripts continentept-mcp@<pinned version> && npm run contract:check
```

Add-on options are translated in `continente_mcp/translations/`. To publish prebuilt images to GHCR, grant this
repository write access to the `ghcr.io/jpch/{arch}-continente-mcp` packages, set the repository variable
`PUBLISH_IMAGES=true` and add `image: ghcr.io/jpch/{arch}-continente-mcp` to `continente_mcp/config.yaml`.

## Changelog and licence

[CHANGELOG.md](CHANGELOG.md); each GitHub release carries the notes of its version. Licence: [MIT](LICENSE).
