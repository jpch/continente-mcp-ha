# Remote access through Home Assistant ingress

Port 8100 is meant for the home network only. Away from home, reach the add-on through Home Assistant's own
ingress proxy on the external Home Assistant URL (Nabu Casa, Cloudflared, a reverse proxy).

1. Authenticate to Home Assistant's WebSocket API (`wss://<external HA URL>/api/websocket`) with a Home Assistant
   **administrator** long-lived access token (the add-on page is admin-only, `panel_admin: true`).
2. `{"type":"supervisor/api","endpoint":"/addons/<slug>/info","method":"get"}` → `result.ingress_url`.
   The slug is `<repository hash>_continente_mcp`; `GET /health` on the home network reports it (`addon_slug`).
3. `{"type":"supervisor/api","endpoint":"/ingress/session","method":"post"}` → `result.session`.
4. Send MCP requests to `https://<external HA URL><ingress_url>mcp` with the cookie `ingress_session=<session>`
   and the header `X-Continente-MCP-Token: cmcp_…`.
5. Every few minutes, `{"type":"supervisor/api","endpoint":"/ingress/validate_session","method":"post","data":{"session":"<session>"}}`.
   Ingress sessions expire after about 15 minutes of inactivity.

The agent token is still required through ingress: a Home Assistant login alone cannot call tools. Through
ingress, `/mcp` and `/health` behave exactly as on the home network.

A small local bridge (for clients that cannot do steps 1–3) is out of scope for this add-on.
