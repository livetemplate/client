# @livetemplate/client

TypeScript/JavaScript client library for LiveTemplate - reactive HTML over the wire.

## Overview

The LiveTemplate client enables reactive web applications by efficiently applying tree-based HTML updates from the server. It uses DOM morphing, intelligent static content caching, and WebSocket transport for real-time interactivity.

## Features

- **Tree-based Updates**: Efficiently applies minimal JSON updates to the DOM
- **Static Structure Caching**: Client caches static HTML, receives only dynamic changes
- **DOM Morphing**: Uses morphdom for efficient, minimal DOM updates
- **WebSocket Transport**: Real-time bidirectional communication
- **Focus Management**: Preserves focus during updates
- **Form Lifecycle**: Automatic form state management
- **Event Delegation**: Efficient event handling
- **Modal Management**: Built-in modal support
- **TypeScript**: Full type safety and IDE support

## Installation

### npm

```bash
npm install @livetemplate/client
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/@livetemplate/client@0.1.0/dist/livetemplate-client.browser.js"></script>
```

## Quick Start

### Browser (via CDN)

```html
<!DOCTYPE html>
<html>
<head>
    <script src="https://cdn.jsdelivr.net/npm/@livetemplate/client@0.1.0/dist/livetemplate-client.browser.js"></script>
</head>
<body>
    <div id="app"></div>
    <script>
        const client = new LiveTemplateClient.LiveTemplateClient({
            targetSelector: "#app",
            wsUrl: "ws://localhost:8080/ws",
            httpUrl: "http://localhost:8080"
        });

        client.connect();
    </script>
</body>
</html>
```

### TypeScript/ES Modules

```typescript
import { LiveTemplateClient } from "@livetemplate/client";

const client = new LiveTemplateClient({
    targetSelector: "#app",
    wsUrl: "ws://localhost:8080/ws",
    httpUrl: "http://localhost:8080"
});

client.connect();
```

## Configuration Options

```typescript
interface LiveTemplateClientOptions {
    // Required
    targetSelector: string;      // CSS selector for target element
    wsUrl: string;                // WebSocket URL
    httpUrl: string;              // HTTP URL for initial render

    // Optional
    debug?: boolean;              // Enable debug logging (default: false)
    reconnectInterval?: number;   // Reconnect interval in ms (default: 3000)
    maxReconnectAttempts?: number;// Max reconnect attempts (default: 10)
}
```

## API

### Client Methods

```typescript
// Connect to server
client.connect(): void

// Disconnect from server
client.disconnect(): void

// Send event to server
client.sendEvent(event: string, data: any): void

// Set debug mode
client.setDebug(enabled: boolean): void
```

### Events

The client emits events you can listen to:

```typescript
// Connection established
window.addEventListener("livetemplate:connected", (e) => {
    console.log("Connected to server");
});

// Connection closed
window.addEventListener("livetemplate:disconnected", (e) => {
    console.log("Disconnected from server");
});

// Update received
window.addEventListener("livetemplate:update", (e) => {
    console.log("Received update:", e.detail);
});
```

## How It Works

1. **Initial Render**: Client fetches full HTML from server, caches static structure
2. **Updates**: Server sends only changed dynamic values as tree updates
3. **DOM Morphing**: Client applies updates using morphdom for minimal DOM changes
4. **Caching**: Static HTML structure is cached, never re-transmitted

This results in **~75% reduction** in update payload sizes compared to full HTML updates.

## Development

### Setup

```bash
# Clone repository
git clone https://github.com/livetemplate/client.git
cd client

# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
```

### Project Structure

```
client/
├── livetemplate-client.ts       # Main client
├── dom/                         # DOM utilities
│   ├── directives.ts
│   ├── event-delegation.ts
│   ├── focus-manager.ts
│   ├── form-disabler.ts
│   ├── loading-indicator.ts
│   ├── modal-manager.ts
│   └── observer-manager.ts
├── state/                       # State management
│   ├── form-lifecycle-manager.ts
│   └── tree-renderer.ts
├── transport/                   # Network layer
│   └── websocket.ts
├── utils/                       # Utilities
│   ├── logger.ts
│   ├── rate-limit.ts
│   └── testing.ts
└── tests/                       # Test suite
```

### Running Tests

```bash
# Run all tests
npm test

# Run specific test
npm test -- focus-manager

# Run with coverage
npm test -- --coverage
```

### Building

```bash
# Build TypeScript and browser bundle
npm run build

# Build browser bundle only
npm run build:browser

# Clean build artifacts
npm run clean
```

## Related Projects

- **[LiveTemplate Core](https://github.com/livetemplate/livetemplate)** - Go library for server-side rendering
- **[LVT CLI](https://github.com/livetemplate/lvt)** - Code generator and development server
- **[Examples](https://github.com/livetemplate/examples)** - Example applications

## Version Synchronization

This client library follows the LiveTemplate core library's major.minor version. For example:

- Core: `v0.1.5` → Client: `v0.1.x` (any patch version)
- Core: `v0.2.0` → Client: `v0.2.0` (must match major.minor)

Patch versions are independent and can be incremented for client-specific fixes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/livetemplate/client/issues)
- **Discussions**: [GitHub Discussions](https://github.com/livetemplate/client/discussions)
- **Documentation**: [LiveTemplate Docs](https://github.com/livetemplate/livetemplate)
