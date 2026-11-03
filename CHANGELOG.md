# Changelog

All notable changes to this repository are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
