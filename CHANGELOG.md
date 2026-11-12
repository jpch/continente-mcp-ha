# Changelog

All notable changes to this repository are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.4] - 2026-11-12
### Changed
- Installed `continentept-mcp` updated from 0.13.0 to 0.14.0 (automated update; the tool contract changed and was reviewed before merging).

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
