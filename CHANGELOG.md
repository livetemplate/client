# Changelog

All notable changes to @livetemplate/client will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
