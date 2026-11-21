# Changelog

All notable changes to this repository are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.5] - 2026-11-21
### Changed
- `continentept-mcp` updated from 0.15.0 to 0.16.1 (reviewed). No tool was added or removed and every input and output
  schema is unchanged; only the `choose_products` description changed. The coupon tools (`list_coupons`,
  `set_cart_coupons`) stay hidden and refused for every token, with or without `allow_checkout`. Upstream fixes that
  reach the add-on:
  - The browser refuses cart and coupon writes from pages opened only to read products, orders or the cart. The cart
    tools' own requests are unaffected.
  - Chromium starts with its sandbox where the container allows it. Otherwise it starts without it and logs that once.
  - Playwright debug output never records the password or session cookies.
  - Sign-in types only into documents on the Continente login page.
  - A replaced `session.json` is detected by its contents, not its modification time.
  - A settled order read while the session was being replaced is no longer kept for the new session.
### Fixed
- The `allow_checkout` option text named continentept-mcp 0.13.0. It no longer names a version.

## [1.0.4] - 2026-11-17
### Changed
- `continentept-mcp` updated from 0.13.0 to 0.15.0 (reviewed; 0.14.0 skipped). No tool was added or removed. Output
  changes: prices and unit prices can be `per: "dose"` (detergents, per wash); promotions gain `takePay`
  (`Leve X Pague Y`, nullable); `search_products` gains the `promotion` input and the `favoritesPromoted` output;
  `list_coupons.cartSelection` can be `unknown`; the sign-in details give `npx -y continentept-mcp login --show-browser`.
- The saved Continente session is now tied to the saved account (upstream 0.15.0). A session saved by an earlier
  version is not used: sign in once on the add-on page after updating. The sign-in on the page and the server read the
  same account, so that sign-in is the one the server uses.
- Sign-in errors tell agents to ask the user to sign in on the Continente MCP add-on page, instead of the upstream
  advice to run `npx … login` or copy `session.json`, which does not apply here.
### Removed
- The one-time session hand-off from Cesto before 2.0.0 (`/share/continente-mcp/import/`). A leftover hand-off folder
  is deleted without being read.

## [1.0.3] - 2026-11-11
### Changed
- `continentept-mcp` updated from 0.12.1 to 0.13.0 (reviewed). The only change to the 15 existing tools is in the
  error envelope: `mutation.recovery.action` can now be `list_coupons` as well as `get_cart`. The reviewed snapshot
  (`server/contract/upstream-tools.json`) now holds 17 tools.
- 0.13.0 also makes the browser refuse payment, order submission and delivery-slot reservation itself (upstream
  security change).
- Dependencies: fastify 5.12.8, @types/node 22.20.5, vitest 5.1.0; CI uses actions/setup-node 7.1.0 (pinned by SHA).
### Security
- The new `list_coupons` and `set_cart_coupons` tools are never listed or called, for any token, and `allow_checkout`
  does not unlock them (`NEVER_EXPOSED_TOOL` in `server/src/policy.ts`; the contract report marks such tools). A
  refused call is logged with the agent name.
### Added
- European Portuguese translation of the add-on options (`translations/pt.yaml`).
- Dependabot for npm (`continente_mcp/server`, the smoke test) and GitHub Actions. `continentept-mcp` stays with
  `upstream-bump.yaml`.
- A Changelog section in the README.

## [1.0.2] - 2026-11-03
### Fixed
- A session handed off by Cesto was ignored when the upstream had already created an empty browser profile on first start. The add-on now counts only a saved account or a session that was once valid as its own.
- `/health` reported version 1.0.0.

## [1.0.1] - 2026-11-03
### Changed
- Home Assistant now builds the add-on locally instead of pulling a prebuilt image. Prebuilt images are only pushed to GHCR when the repository variable `PUBLISH_IMAGES` is `true` (see README).

## [1.0.0] - 2026-11-03
### Added
- First release. Runs `continentept-mcp` 0.12.1 (unchanged, from npm) behind an MCP server over streamable HTTP on port 8100 (`/mcp`) and through Home Assistant ingress.
- Per-agent tokens created and revoked on the add-on page (shown once; SHA-256 hashes in `/data/tokens.json`), token requests from other add-ons approved on the page.
- Every token may read and change the cart; checkout/payment-like tools are blocked unless `allow_checkout` is on (default off). Cart changes are logged with the agent name.
- Single serial queue in front of the Chromium MCP, with priority tokens first.
- Continente account and on-demand sign-in through noVNC on the add-on page; one-time import of an existing session handed off by Cesto.
- Daily `continentept-mcp` update workflow with a tool contract check.
