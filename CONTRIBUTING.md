# Contributing to @livetemplate/client

Thank you for your interest in contributing to the LiveTemplate client library!

## Development Setup

### Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/livetemplate/client.git
cd client

# Install dependencies
npm install

# Install git hooks
./scripts/install-hooks.sh

# Run tests
npm test

# Build
npm run build
```

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Changes

- Write code following existing patterns
- Add tests for new functionality
- Update documentation as needed
- Ensure all tests pass

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Run specific test file
npm test -- focus-manager

# Run with coverage
npm test -- --coverage

# Build to verify no errors
npm run build
```

### 4. Commit Your Changes

The repository has a pre-commit hook that will:
- Run linter (if configured)
- Run all tests
- Build the project

Commits must pass all checks before they can be committed.

```bash
git add .
git commit -m "feat: add new feature"
```

#### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `test:` Adding or updating tests
- `refactor:` Code refactoring
- `perf:` Performance improvements
- `chore:` Build process or tooling changes

Examples:
```
feat: add keyboard navigation support
fix: prevent focus loss during updates
docs: update API documentation
test: add tests for modal manager
```

### 5. Push and Create PR

```bash
git push origin feature/your-feature-name
```

Then create a Pull Request on GitHub.

## Code Style

### TypeScript

- Use TypeScript for all code
- Provide type definitions
- Avoid `any` types when possible
- Document public APIs with JSDoc comments

### Naming Conventions

- **Classes**: PascalCase (`LiveTemplateClient`, `FocusManager`)
- **Functions**: camelCase (`sendEvent`, `morphTree`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- **Private members**: prefix with underscore (`_internalState`)

### File Organization

- One class/component per file
- Group related functionality in directories
- Export from index files when appropriate

## Testing Guidelines

### Test Structure

```typescript
describe("ComponentName", () => {
    describe("method", () => {
        it("should do something specific", () => {
            // Arrange
            const component = new Component();

            // Act
            const result = component.method();

            // Assert
            expect(result).toBe(expected);
        });
    });
});
```

### Test Coverage

- Aim for >80% code coverage
- Test happy paths and error cases
- Test edge cases and boundary conditions
- Mock external dependencies

### Running Tests

```bash
# All tests
npm test

# Watch mode (for development)
npm test -- --watch

# With coverage
npm test -- --coverage

# Specific file
npm test -- event-delegation.test.ts
```

## Adding New Features

### 1. DOM Utilities

Add to `dom/` directory:

```typescript
// dom/my-feature.ts
export class MyFeature {
    constructor(private element: HTMLElement) {}

    public doSomething(): void {
        // Implementation
    }
}
```

### 2. State Management

Add to `state/` directory for features that manage application state.

### 3. Transport Layer

Add to `transport/` directory for network-related features.

### 4. Update Main Client

If the feature should be part of the main client API, update `livetemplate-client.ts`:

```typescript
import { MyFeature } from "./dom/my-feature";

export class LiveTemplateClient {
    private myFeature: MyFeature;

    constructor(options: LiveTemplateClientOptions) {
        // ...
        this.myFeature = new MyFeature(this.targetElement);
    }
}
```

## Versioning

The client follows the core library's major.minor version:

- **Patch versions**: Independent, for client-specific bug fixes
- **Minor versions**: Match core library minor version
- **Major versions**: Match core library major version

Before releasing:
1. Ensure version matches core library's major.minor
2. Update CHANGELOG.md
3. Run `./scripts/release.sh`

## Release Process

Releases are automated via `scripts/release.sh`:

```bash
# Dry run (no changes)
./scripts/release.sh --dry-run

# Actual release
./scripts/release.sh
```

The script will:
1. Validate version against core library
2. Update VERSION and package.json
3. Generate CHANGELOG.md
4. Run tests and build
5. Commit and tag
6. Publish to npm
7. Create GitHub release

## Protocol Changes

If the LiveTemplate protocol changes (tree format, WebSocket messages, etc.):

1. Check with core library team for compatibility
2. Update client to handle new format
3. Maintain backward compatibility when possible
4. Document breaking changes in CHANGELOG
5. Coordinate release with core library

## Documentation

### README.md

Update for:
- New features
- API changes
- Configuration options
- Examples

### Code Comments

- Document public APIs with JSDoc
- Explain complex logic inline
- Keep comments up-to-date

### Examples

Add examples for new features in:
- README.md Quick Start section
- Inline code comments
- Test files (as usage examples)

## Getting Help

- **Questions**: [GitHub Discussions](https://github.com/livetemplate/client/discussions)
- **Bugs**: [GitHub Issues](https://github.com/livetemplate/client/issues)
- **Core Library**: [LiveTemplate Repo](https://github.com/livetemplate/livetemplate)

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Collaborate openly

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
