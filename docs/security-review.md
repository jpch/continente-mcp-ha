# Security review

## Continente MCP add-on 1.0.0

Reviewed 2026-11-03 before release (high-risk change: agent tokens, remote access, Continente account and
session). Scope: the whole add-on (`continente_mcp/`), its workflows and the hand-off with Cesto 2.0.0.
Verdict: **no Critical or High findings; release allowed.** Medium findings are accepted with the reasons below.

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | Authentication | `/mcp` needs a token (`Authorization: Bearer cmcp_…` or `X-Continente-MCP-Token`); 401 otherwise, before the body is parsed into an MCP call. Tokens are 32 random bytes (base64url), compared by SHA-256 hash lookup; only the hash is stored (`/data/tokens.json`, 0600, atomic write). A token is returned once, in the create response to the HA-admin page, and never logged (`test/admin.test.ts` asserts it is absent from logs, status and later responses). | None | OK |
| 2 | Authorisation | The page and `/api/admin/*` answer only from the ingress proxy address and, when HA forwards a user, only for `system-admin` members; from the LAN they are 403. State-changing admin calls require a JSON content type, so cross-site forms cannot reach them; no CORS headers are ever sent. | None | OK |
| 3 | Ingress identity | A request from the ingress address without `X-Remote-User-*` headers is treated as an admin, as in Cesto. Only the Supervisor uses that address and it always forwards the HA user on ingress sessions. | Low | Accepted |
| 4 | Checkout and payment | `ToolPolicy` lists and calls only tools in the reviewed snapshot; checkout/payment/order-placing/delivery-slot/voucher/coupon/billing/card-like names also need `allow_checkout` (default false; only an explicit `true` enables it). The pinned continentept-mcp has no checkout or payment tool. Coupon and voucher tools (`list_coupons`, `set_cart_coupons`) are never exposed, even with `allow_checkout` (`NEVER_EXPOSED_TOOL`). The build fails if the installed package's tools differ from the snapshot. | None | OK |
| 5 | Cart changes | Every token may change the cart (as requested). Each change is logged as `[cart] agent="…" tool=… product=… quantity=… status=…`; names are restricted to letters, digits, space, `._-`, so log lines cannot be forged. Cart calls are never retried. | None | OK |
| 6 | Abuse | 120 calls a minute per token, at most 50 waiting calls, 1 MB body limit; one serial queue, priority tokens first. | None | OK |
| 7 | Token requests through `/share` | Any add-on that maps `/share` can write a request. Nothing is granted until an HA admin approves it on the page, where the request shows its name and fingerprint; Cesto shows the same fingerprint on its page. Requests are regular files ≤ 4 KB with a strict schema; symlinks are ignored. An admin who approves a request without comparing the fingerprint could give a token to another add-on. | Medium | Accepted: requires an installed add-on with `/share` access plus an admin approval; documented in the README and on the page. |
| 8 | Session hand-off through `/share` | Cesto 2.0.0 copies its old session and account (including the password file) to `/share/continente-mcp/import/` once; this add-on imports it within 5 s only if it has no session, and deletes it either way. During those seconds another add-on mapping `/share` could read it, or could plant its own session before Cesto does (only while this add-on has none). | Medium | Accepted: one-time, seconds long, needs an already-installed add-on with `/share` access (which in Home Assistant is trusted code); afterwards nothing secret stays in `/share`. Users without Cesto 1.x never use it. |
| 9 | Remote access | Remote use goes through HA ingress (HA authentication first, then the agent token). Port 8100 is meant for the LAN; the README says not to forward it. | Low | Accepted |
| 10 | Credentials | The Continente password is write-only (`/data/continente/credentials.env`, 0600), never returned, never logged. noVNC runs only during a sign-in, on localhost, proxied through ingress only. | None | OK |
| 11 | Public health | `/health` (no auth) shows version, session validity, sign-in state, queue length and the slug; no account, cart or token data. | Low | Accepted |
| 12 | Supply chain | `continentept-mcp` is installed from npm at a pinned version; updates come only through the daily workflow, which waits 72 h after an upstream release, inspects `tools/list` with `--ignore-scripts` and no browser, and auto-merges only when the tool contract is unchanged. Actions are pinned by SHA; `npm audit` reports 0 vulnerabilities. | Low | Accepted |
| 13 | Repository setting | The update workflow needs "Allow GitHub Actions to create and approve pull requests"; only `upstream-bump.yaml` requests `pull-requests: write`. | Low | Accepted |
| 14 | Repository content | No secrets, personal data, IP addresses or host names are committed (checked with a grep for addresses, e-mail addresses and tokens before release). | None | OK |

## 1.0.2 addendum

- Finding #8 (session hand-off through `/share`) re-checked after the import fix: the import window is unchanged in practice. It is open only while the add-on has no saved account and has never had a valid session. After the first valid session (marker `/data/session-established`) or once an account is saved, no hand-off is accepted. Severity stays Medium (accepted).
