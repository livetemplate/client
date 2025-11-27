# Changelog

All notable changes to @livetemplate/client will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
