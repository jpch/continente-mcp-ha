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
  slots, vouchers, coupons, billing or cards are hidden from `tools/list` and refused. Coupon and voucher tools
  (`list_coupons`, `set_cart_coupons`) are never exposed, not even with `allow_checkout`.
- Only tools in the reviewed contract snapshot (`continente_mcp/server/contract/upstream-tools.json`) are ever
  listed or called.
- When Continente needs a sign-in, the tool error tells the agent to ask you to sign in on the add-on page.
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
the add-on slug, whether the Continente session is valid, whether a sign-in is open, the queue length,
`allow_checkout`, whether the keep-alive is on and whether the add-on's Home Assistant notification works.

## Continente session

Continente ends a session after about 30 minutes without requests (and probably after about 6 hours in any case).

**Recommended:** `session_keepalive: true` together with `unattended_sign_in: false`.

- **Keep-alive** (`session_keepalive`, off by default): while the session is valid, the add-on sends one read-only
  `get_cart` when no signed-in Continente request returned a result for `session_keepalive_minutes` (default 15,
  ±20% random). It runs only when no agent call is waiting. It stops at the first expired result and
  `session_keepalive_max_hours` (1–12, default 6) after the sign-in. It **never signs in**:
  - with `unattended_sign_in: false`, the check goes through the same `continentept-mcp` process agents use, which then
    has no password, so it refreshes exactly the browser session agents use;
  - with `unattended_sign_in: true`, the check runs in a separate, short-lived `continentept-mcp` process without the
    password (same saved session, its own browser), so a check can never start an unattended sign-in.
  A check that gets no answer within 60 s is abandoned (the process is closed) and tried again one interval later.
- **Notification:** when the session expires, Home Assistant shows a persistent notification with a link to the
  add-on page. It goes away by itself once the session is valid again, and is shown again after a Home Assistant
  restart while the session is still expired. With `session_sensor` on, the add-on also publishes
  `binary_sensor.continente_mcp_session`.
- **Unattended sign-in** (`unattended_sign_in`, on by default): `continentept-mcp` may sign in again on its own in a
  hidden browser with the saved password. Continente's "Não sou um robô" check stops it, and it is never answered
  automatically. Turn it off to sign in only on the add-on page.

## Queue and priority

Every call from every agent goes through one serial queue. Tokens marked **priority** (for Cesto) run before waiting
calls of other agents; a running call is never interrupted. At most 50 calls wait (then `busy`), and each token is
limited to 120 calls a minute (`rate_limited`).

## Other add-ons

The add-on maps `/share` and uses `/share/continente-mcp`:

- `endpoint.json`: host name, port and slug, so other add-ons can find it. No secret.
- `requests/<name>.json`: another add-on asks for a token by writing only its SHA-256 hash and a name. The request
  appears on the add-on page with a fingerprint and does nothing until an administrator approves it.

## Options

| Option | Default | |
|---|---|---|
| `allow_checkout` | `false` | Expose checkout/payment-like tools, if a reviewed `continentept-mcp` version ever offers one. |
| `session_keepalive` | `false` | Keep the Continente session alive with a read-only cart check (see above). |
| `session_keepalive_minutes` | `15` | 10–45 minutes without requests before a check, ±20%. |
| `session_keepalive_max_hours` | `6` | 1–12: stop the keep-alive this many hours after the sign-in. |
| `unattended_sign_in` | `true` | Let `continentept-mcp` sign in again on its own with the saved password. |
| `session_sensor` | `false` | Publish `binary_sensor.continente_mcp_session`. |
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. |

## Security

- Tokens are random 256-bit values; only their SHA-256 hashes are stored (`/data/tokens.json`, mode 0600).
- The page and admin API answer only through Home Assistant ingress, for Home Assistant administrators.
- The add-on uses the Home Assistant Core API (`homeassistant_api`) only for the session notification and sensor.
  The Supervisor token is removed from the environment at start; child processes get an allowlisted environment.
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
