# Changelog

All notable changes to @livetemplate/client will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.8.0] - 2026-01-18

### Changes




## [v0.7.12] - 2026-01-10

### Changes

- fix(event-delegation): debounce captures latest input value (3d5b5e9)
- fix(client): skip debounce for search event (clear button) (35adeb7)
- fix(client): handle search event for input type="search" clear button (9afc00e)



## [v0.7.11] - 2026-01-05

### Changes

- fix(tree-renderer): handle range→non-range transitions in deepMergeTreeNodes (#16) (f95a08b)



## [v0.7.10] - 2026-01-04

### Changes

- feat(modal): add data-modal-close-action attribute support (#15) (c8321b3)
- fix(ci): increase max-turns and simplify review prompt (bba2fe7)
- fix(ci): use stable claude-code-action v1 with correct inputs (eb2d2e4)
- feat(modal): add data-modal-close-action attribute support (8bf64f4)
- fix(ci): use correct input parameter for claude-code-action (50c8a1f)



## [v0.7.9] - 2026-01-03

### Changes

- fix(release): sync with full core library version (9d5be47)
- fix(modal): simplify modal close button handling (#14) (404b210)



## [v0.7.7] - 2025-12-26

### Changes

- fix: query params in WebSocket URL + password field handling (#13) (42604a6)



## [v0.7.4] - 2025-12-23

### Changes

- add .npmrc (0e1ef6e)



## [v0.7.3] - 2025-12-22

### Changes

- fix: support heterogeneous range items with per-item statics (#12) (badad08)
- fix: handle plain data objects gracefully in tree renderer (#11) (c64fb24)
- feat: client updates for livepage features (#10) (cb6af54)
- fix: apply differential ops to existing range structures (#9) (50a3ebc)
- fix: handle objects with only numeric keys in renderValue (#8) (b1c7827)
- feat: add lvt-focus-trap and lvt-autofocus attributes (#7) (7b14402)
- feat: add reactive attributes for action lifecycle events (#6) (46e2065)



## [v0.7.2] - 2025-12-20

### Changes

- fix: support heterogeneous range items with per-item statics (#12)
- fix: handle plain data objects gracefully in tree renderer (#11) (c64fb24)
- feat: client updates for livepage features (#10) (cb6af54)
- fix: apply differential ops to existing range structures (#9) (50a3ebc)
- fix: handle objects with only numeric keys in renderValue (#8) (b1c7827)
- feat: add lvt-focus-trap and lvt-autofocus attributes (#7) (7b14402)
- feat: add reactive attributes for action lifecycle events (#6) (46e2065)



## [v0.7.1] - 2025-12-14

### Changes

- fix: apply differential ops to existing range structures (#9) (50a3ebc)
- fix: handle objects with only numeric keys in renderValue (#8) (b1c7827)
- feat: add lvt-focus-trap and lvt-autofocus attributes (#7) (7b14402)
- feat: add reactive attributes for action lifecycle events (#6) (46e2065)



## [v0.7.0] - 2025-12-10

### Changes




## [v0.7.0] - 2025-12-10

### Changes

- feat: add lvt-focus-trap and lvt-autofocus attributes (#7) (7b14402)
- feat: add reactive attributes for action lifecycle events (#6) (46e2065)



## [v0.4.1] - 2025-11-27

### Changes

- feat: improve test coverage from 38% to 60% (#4) (9755643)
- Add Claude Code GitHub Workflow (#5) (79e3d0b)



## [v0.4.0] - 2025-11-22

### Changes

- fix: use numeric constant instead of WebSocket.OPEN (#3) (6462ccb)
- fix(upload): clear file input after successful upload to prevent duplicate uploads (af6f7aa)
- feat(upload): implement AutoUpload config and form submit trigger (b77e1ff)


Initial release of @livetemplate/client as a standalone package.

### Features

- TypeScript client for LiveTemplate tree-based updates
- WebSocket transport for real-time updates
- DOM morphing with morphdom
- Focus management and form lifecycle
- Event delegation
- Modal management
