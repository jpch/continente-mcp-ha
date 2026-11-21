# Continente MCP

Runs the original `continentept-mcp` as an MCP server over HTTP for AI agents, with per-agent tokens. Checkout and
payment stay blocked; coupon tools are never available.

## Setup

1. Start the add-on and open its page (sidebar **Continente MCP**, administrators only).
2. Save the Continente email and password, then **Sign in to Continente** and finish the sign-in in the browser shown
   on the page (Continente may ask you to tick "Não sou um robô").
3. Create one token per agent under **Agent tokens**. Agents connect to `http://<home-assistant-address>:8100/mcp`
   with `Authorization: Bearer cmcp_…`.

## Keeping the session

Continente ends a session after about 30 idle minutes. Recommended options:

```yaml
session_keepalive: true
unattended_sign_in: false
```

- The keep-alive sends one read-only cart check (`get_cart`) after `session_keepalive_minutes` (10–45, default 15,
  ±20%) without a signed-in request, only when no agent call is waiting, and stops `session_keepalive_max_hours`
  (1–12, default 6) after the sign-in or when the session has expired. It never signs in.
- With `unattended_sign_in: false` the add-on never signs in on its own: the check refreshes the same browser session
  agents use, and when the session ends Home Assistant shows a notification with a link to this page, where you sign
  in again. With `unattended_sign_in: true` (default) `continentept-mcp` tries a hidden sign-in with the saved password
  first; the check then runs in a separate process without the password.
- `session_sensor: true` adds `binary_sensor.continente_mcp_session`.

More: [README](https://github.com/jpch/continente-mcp-ha#readme).
