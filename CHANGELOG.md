# Changelog

All notable changes to @livetemplate/client will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.1.0] - 2025-11-03

Initial release of @livetemplate/client as a standalone package extracted from the LiveTemplate monorepo.

### Features

- **Tree-based Updates**: Efficient DOM updates using tree-based JSON format
- **Static Structure Caching**: Client caches static HTML structure, receives only dynamic changes
- **DOM Morphing**: Uses morphdom for minimal DOM manipulation
- **WebSocket Transport**: Real-time bidirectional communication with automatic reconnection
- **Focus Management**: Preserves focus during DOM updates
- **Form Lifecycle**: Automatic form state management and submission handling
- **Event Delegation**: Efficient event handling with delegation
- **Modal Management**: Built-in modal support with overlay and focus trapping
- **Loading Indicators**: Automatic loading state management
- **Observer Management**: MutationObserver integration for dynamic content
- **TypeScript Support**: Full type definitions and IDE support
- **Browser Bundle**: Pre-built browser bundle via CDN
- **Rate Limiting**: Built-in rate limiting for event submissions
- **Debug Logging**: Configurable debug output for development

### Infrastructure

- **CI/CD**: GitHub Actions for testing and npm publishing
- **Release Automation**: Automated release script with version synchronization
- **Pre-commit Hooks**: Automated testing and build verification
- **Version Tracking**: VERSION file for release management
- **Test Suite**: Comprehensive Jest test coverage

### Documentation

- Complete README with examples and API documentation
- Contributing guidelines
- Version synchronization strategy with core library

### Related Versions

- Core Library: v0.1.0
- CLI Tool: v0.1.0
- Examples: v0.1.0

---

## Version Synchronization

This client follows the LiveTemplate core library's major.minor version (X.Y):

- Patch versions (X.Y.Z) are independent
- Minor/major versions must match core library
- See README.md for details
