#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
log_info() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }
log_step() { echo -e "${BLUE}▸${NC} $1"; }

# Check prerequisites
check_prerequisites() {
    local missing=()

    command -v gh >/dev/null 2>&1 || missing+=("gh (GitHub CLI)")
    command -v npm >/dev/null 2>&1 || missing+=("npm")
    command -v jq >/dev/null 2>&1 || missing+=("jq (JSON processor)")

    if [ ${#missing[@]} -ne 0 ]; then
        log_error "Missing required tools: ${missing[*]}"
        echo ""
        echo "Install with:"
        echo "  macOS:   brew install gh npm jq"
        echo "  Linux:   apt-get install gh npm jq"
        exit 1
    fi

    # Check GitHub CLI auth
    if ! gh auth status >/dev/null 2>&1; then
        log_error "GitHub CLI not authenticated. Run 'gh auth login' first"
        exit 1
    fi
}

# Get core library version
get_core_library_version() {
    # Get latest release from GitHub API
    local core_version=$(gh release list --repo livetemplate/livetemplate --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || echo "")

    if [ -z "$core_version" ]; then
        log_error "Could not fetch core library version"
        log_info "Make sure github.com/livetemplate/livetemplate has releases"
        exit 1
    fi

    # Remove 'v' prefix if present
    core_version=${core_version#v}

    # Only echo the version, no logging (to avoid capturing log output)
    echo "$core_version"
}

# Extract major.minor from version
get_major_minor() {
    local version=$1
    IFS='.' read -r major minor patch <<< "$version"
    echo "${major}.${minor}"
}

# Get current version
get_current_version() {
    if [ ! -f VERSION ]; then
        log_warn "VERSION file not found, checking package.json"
        if [ -f package.json ]; then
            jq -r '.version' package.json
        else
            echo "0.0.0"
        fi
    else
        cat VERSION | tr -d '\n'
    fi
}

# Validate version against core library
validate_version() {
    local new_version=$1
    local core_version=$(get_core_library_version)

    local new_major_minor=$(get_major_minor "$new_version")
    local core_major_minor=$(get_major_minor "$core_version")

    if [ "$new_major_minor" != "$core_major_minor" ]; then
        log_error "Version mismatch!"
        echo ""
        echo "  Client version: $new_version (major.minor: $new_major_minor)"
        echo "  Core version:   $core_version (major.minor: $core_major_minor)"
        echo ""
        echo "Client must match core library's major.minor version."
        echo "Use: ${core_major_minor}.X where X is any patch version"
        exit 1
    fi

    log_info "Version validated against core library (major.minor: $core_major_minor)"
}

# Bump version
bump_version() {
    local current_version=$1
    local bump_type=$2

    IFS='.' read -r major minor patch <<< "$current_version"

    case $bump_type in
        major)
            major=$((major + 1))
            minor=0
            patch=0
            ;;
        minor)
            minor=$((minor + 1))
            patch=0
            ;;
        patch)
            patch=$((patch + 1))
            ;;
        *)
            echo "$bump_type"  # Allow custom version
            return
            ;;
    esac

    echo "${major}.${minor}.${patch}"
}

# Update all version files
update_versions() {
    local new_version=$1

    log_step "Updating VERSION file to $new_version"
    echo "$new_version" > VERSION

    log_step "Updating package.json to $new_version"
    npm version "$new_version" --no-git-tag-version --allow-same-version > /dev/null 2>&1

    log_info "All version files updated to $new_version"
}

# Generate changelog
generate_changelog() {
    local new_version=$1
    local prev_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    log_step "Generating changelog for v$new_version"

    if [ -n "$prev_tag" ]; then
        {
            echo "# Changelog"
            echo ""
            echo "All notable changes to @livetemplate/client will be documented in this file."
            echo ""
            echo "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),"
            echo "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)."
            echo ""
            echo "## [v$new_version] - $(date +%Y-%m-%d)"
            echo ""
            echo "### Changes"
            echo ""
            git log "$prev_tag"..HEAD --pretty=format:"- %s (%h)" --no-merges | grep -v "^- Merge " || true
            echo ""
            echo ""
            tail -n +7 CHANGELOG.md 2>/dev/null || true
        } > CHANGELOG.md.tmp
        mv CHANGELOG.md.tmp CHANGELOG.md
    else
        {
            echo "# Changelog"
            echo ""
            echo "All notable changes to @livetemplate/client will be documented in this file."
            echo ""
            echo "## [v$new_version] - $(date +%Y-%m-%d)"
            echo ""
            echo "Initial release of @livetemplate/client as a standalone package."
            echo ""
            echo "### Features"
            echo ""
            echo "- TypeScript client for LiveTemplate tree-based updates"
            echo "- WebSocket transport for real-time updates"
            echo "- DOM morphing with morphdom"
            echo "- Focus management and form lifecycle"
            echo "- Event delegation"
            echo "- Modal management"
        } > CHANGELOG.md
    fi
}

# Commit and tag
commit_and_tag() {
    local new_version=$1

    log_step "Committing version bump"
    git add VERSION package.json package-lock.json CHANGELOG.md
    git commit -m "chore(release): v$new_version

Release @livetemplate/client v$new_version

This release follows the core library version: $(get_major_minor "$new_version").x

🤖 Generated with automated release script"

    log_step "Creating git tag v$new_version"
    git tag -a "v$new_version" -m "Release v$new_version"

    log_info "Committed and tagged v$new_version"
}

# Build and test
build_and_test() {
    log_step "Running npm tests..."
    npm test || {
        log_error "Tests failed, aborting release"
        exit 1
    }
    log_info "Tests passed"

    log_step "Cleaning previous build artifacts..."
    npm run clean

    log_step "Building TypeScript client..."
    npm run build || {
        log_error "Build failed, aborting release"
        exit 1
    }
    log_info "Client built successfully"
}

# Verify build artifacts
verify_build() {
    local new_version=$1
    log_step "Verifying build artifacts..."

    local required_files=(
        "dist/livetemplate-client.js"
        "dist/livetemplate-client.d.ts"
        "dist/livetemplate-client.browser.js"
    )
    for f in "${required_files[@]}"; do
        if [ ! -s "$f" ]; then
            log_error "Missing or empty build artifact: $f"
            exit 1
        fi
    done
    log_info "All required dist files present"

    node -e "
        const m = require('./dist/livetemplate-client.js');
        if (!m.LiveTemplateClient) process.exit(1);
    " || {
        log_error "Smoke test failed: module doesn't export LiveTemplateClient"
        exit 1
    }
    log_info "Smoke test passed"

    local pkg_version
    pkg_version=$(jq -r '.version' package.json)
    if [ "$pkg_version" != "$new_version" ]; then
        log_error "package.json version ($pkg_version) != expected ($new_version)"
        exit 1
    fi

    log_info "Build verification passed"
}

# Verify npm package contents before publishing
verify_package_contents() {
    log_step "Verifying npm package contents..."

    local pack_output
    pack_output=$(npm pack --dry-run 2>&1)

    local required_in_pack=(
        "dist/livetemplate-client.js"
        "dist/livetemplate-client.d.ts"
        "dist/livetemplate-client.browser.js"
    )
    for f in "${required_in_pack[@]}"; do
        if ! echo "$pack_output" | grep -q "$f"; then
            log_error "npm pack missing required file: $f"
            exit 1
        fi
    done

    log_info "Package contents verified"
}

# Publish to npm
publish_npm() {
    local new_version=$1

    log_step "Publishing @livetemplate/client@$new_version to npm"

    # Check if logged in
    if ! npm whoami >/dev/null 2>&1; then
        log_error "Not logged in to npm. Run 'npm login' first"
        exit 1
    fi

    # Publish
    npm publish || {
        log_error "npm publish failed"
        exit 1
    }

    log_info "Published to npm: https://www.npmjs.com/package/@livetemplate/client/v/$new_version"
}

# Extract release notes from CHANGELOG
extract_release_notes() {
    local new_version=$1
    local notes_file="/tmp/release-notes-client-$new_version.md"

    if [ ! -f CHANGELOG.md ]; then
        log_warn "CHANGELOG.md not found, using default release notes"
        echo "Release v$new_version" > "$notes_file"
        echo "" >> "$notes_file"
        echo "TypeScript client for LiveTemplate - reactive HTML over the wire" >> "$notes_file"
        echo "$notes_file"
        return
    fi

    # Extract notes for this version from CHANGELOG
    awk -v ver="$new_version" '
        /^## \[v/ {
            if (found) exit
            if ($0 ~ "\\[v"ver"\\]") {
                found=1
                next
            }
        }
        found && /^## \[v/ { exit }
        found { print }
    ' CHANGELOG.md > "$notes_file"

    # If empty, add default content
    if [ ! -s "$notes_file" ]; then
        log_warn "No changelog entries found for v$new_version, using default notes"
        echo "Release v$new_version" > "$notes_file"
        echo "" >> "$notes_file"
        echo "TypeScript client for LiveTemplate - reactive HTML over the wire" >> "$notes_file"
    fi

    # Add installation instructions
    {
        echo ""
        echo "## Installation"
        echo ""
        echo "### npm"
        echo "\`\`\`bash"
        echo "npm install @livetemplate/client@$new_version"
        echo "\`\`\`"
        echo ""
        echo "### CDN"
        echo "\`\`\`html"
        echo "<script src=\"https://cdn.jsdelivr.net/npm/@livetemplate/client@$new_version/dist/livetemplate-client.browser.js\"></script>"
        echo "\`\`\`"
        echo ""
        echo "## Related Releases"
        echo ""
        echo "This release follows the LiveTemplate core library version $(get_major_minor "$new_version").x"
        echo ""
        echo "- Core Library: https://github.com/livetemplate/livetemplate"
        echo "- CLI Tool: https://github.com/livetemplate/lvt"
        echo "- Examples: https://github.com/livetemplate/examples"
    } >> "$notes_file"

    echo "$notes_file"
}

# Push and create GitHub release
publish_github() {
    local new_version=$1

    local branch
    branch=$(git rev-parse --abbrev-ref HEAD)

    log_step "Pushing commits and tags to GitHub (branch: $branch)"
    git push origin "$branch" || {
        log_error "Failed to push to origin. You may need to 'git pull --rebase origin $branch' first."
        exit 1
    }
    git push origin "v$new_version"
    log_info "Pushed to GitHub"

    # Extract release notes
    log_step "Extracting release notes from CHANGELOG"
    local notes_file=$(extract_release_notes "$new_version")
    log_info "Release notes prepared"

    # Create GitHub release with gh CLI
    log_step "Creating GitHub release v$new_version"
    gh release create "v$new_version" \
        --title "v$new_version" \
        --notes-file "$notes_file" || {
        log_error "Failed to create GitHub release"
        exit 1
    }

    # Cleanup
    rm -f "$notes_file"

    log_info "GitHub release created: https://github.com/livetemplate/client/releases/tag/v$new_version"
}

# Dry run mode
dry_run() {
    local new_version=$1

    echo ""
    echo "🔍 DRY RUN MODE - No changes will be made"
    echo "========================================"
    echo ""

    log_info "Would validate version against core library"
    log_info "Would update VERSION to: $new_version"
    log_info "Would update package.json to: $new_version"
    log_info "Would generate CHANGELOG.md"
    log_info "Would run tests and builds"
    log_info "Would commit with message: chore(release): v$new_version"
    log_info "Would create tag: v$new_version"
    log_info "Would publish @livetemplate/client@$new_version to npm"
    log_info "Would push to GitHub and create release"

    echo ""
    log_info "Dry run completed successfully"
    exit 0
}

# Main release function
main() {
    local dry_run_mode=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dry-run)
                dry_run_mode=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    echo "🚀 LiveTemplate Client Release Automation"
    echo "==========================================="
    echo ""

    check_prerequisites

    # Check git status
    if [ -n "$(git status --porcelain)" ]; then
        log_error "Working directory is not clean. Commit or stash changes first."
        echo ""
        git status --short
        exit 1
    fi

    # Sync with remote before releasing
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD)
    if [ "$branch" = "HEAD" ]; then
        log_error "Detached HEAD state. Run the release from a named branch (e.g., main)."
        exit 1
    fi
    if [ "$dry_run_mode" = true ]; then
        # Note: fetch updates remote-tracking refs in .git — a minor side effect required to check sync state
        log_step "Dry run: fetching origin/$branch to check sync state (network call)"
        if ! git fetch origin "$branch" --quiet; then
            log_error "Could not fetch origin/$branch — cannot verify branch is up to date."
            exit 1
        else
            local behind ahead
            behind=$(git rev-list --count HEAD..origin/"$branch" 2>/dev/null || echo "0")
            ahead=$(git rev-list --count origin/"$branch"..HEAD 2>/dev/null || echo "0")
            if [ "$behind" -gt 0 ] && [ "$ahead" -gt 0 ]; then
                log_error "Branch has diverged from origin/$branch ($ahead ahead, $behind behind). Resolve before releasing."
                exit 1
            elif [ "$behind" -gt 0 ]; then
                log_error "Local branch is $behind commit(s) behind origin/$branch. Pull and re-run."
                exit 1
            elif [ "$ahead" -gt 0 ]; then
                log_warn "Local branch is $ahead commit(s) ahead of origin/$branch — push before releasing."
            else
                log_info "Branch is up to date with origin/$branch"
            fi
        fi
    else
        log_step "Pulling latest changes from origin/$branch"
        git pull --ff-only origin "$branch" || {
            log_error "Failed to fast-forward from origin/$branch. Branch may have diverged or there was a network error. Resolve manually before releasing."
            exit 1
        }
        log_info "Up to date with origin/$branch"
    fi

    # Get current version
    current_version=$(get_current_version)
    log_info "Current version: $current_version"

    # Get core library version for reference
    echo ""
    log_step "Fetching core library version from github.com/livetemplate/livetemplate"
    core_version=$(get_core_library_version)
    core_major_minor=$(get_major_minor "$core_version")
    log_info "Core library version: $core_version (major.minor: $core_major_minor)"
    log_info "Client must use major.minor: $core_major_minor"

    # Ask for version bump type
    echo ""
    echo "Select version bump type:"
    echo "  1) patch (bug fixes)        → $(bump_version "$current_version" patch)"
    echo "  2) sync with core           → ${core_version}"
    echo "  3) custom version           → ${core_major_minor}.X"
    echo ""
    read -rp "Enter choice [1-3]: " choice

    case $choice in
        1) new_version=$(bump_version "$current_version" patch) ;;
        2) new_version="${core_version}" ;;
        3)
            read -rp "Enter patch version for ${core_major_minor}.X: " patch_ver
            if ! [[ $patch_ver =~ ^[0-9]+$ ]]; then
                log_error "Invalid patch version. Must be a number"
                exit 1
            fi
            new_version="${core_major_minor}.${patch_ver}"
            ;;
        *)
            log_error "Invalid choice"
            exit 1
            ;;
    esac

    echo ""
    log_info "New version will be: $new_version"

    # Check if tag already exists
    if git tag --list "v$new_version" | grep -q "v$new_version"; then
        log_error "Tag v$new_version already exists!"
        echo ""
        echo "Existing tags:"
        git tag --list 'v*' | sort -V | tail -5
        exit 1
    fi

    # Validate version
    validate_version "$new_version"

    echo ""
    echo "This will:"
    echo "  • Update VERSION and package.json"
    echo "  • Generate/update CHANGELOG.md"
    echo "  • Run all tests and builds"
    echo "  • Commit and tag v$new_version"
    echo "  • Publish @livetemplate/client@$new_version to npm"
    echo "  • Create GitHub release with release notes"
    echo ""

    if [ "$dry_run_mode" = true ]; then
        dry_run "$new_version"
    fi

    read -rp "Continue? [y/N]: " confirm

    if [[ ! $confirm =~ ^[Yy]$ ]]; then
        log_warn "Release cancelled"
        exit 0
    fi

    echo ""
    log_info "Starting release process..."
    echo ""

    # Execute release steps
    update_versions "$new_version"
    generate_changelog "$new_version"
    build_and_test
    verify_build "$new_version"
    verify_package_contents
    commit_and_tag "$new_version"
    publish_npm "$new_version"
    publish_github "$new_version"

    echo ""
    echo "================================================"
    log_info "✨ Release v$new_version completed successfully!"
    echo "================================================"
    echo ""
    echo "📦 Published artifacts:"
    echo "  • npm:    https://www.npmjs.com/package/@livetemplate/client/v/$new_version"
    echo "  • GitHub: https://github.com/livetemplate/client/releases/tag/v$new_version"
    echo "  • CDN:    https://cdn.jsdelivr.net/npm/@livetemplate/client@$new_version/dist/livetemplate-client.browser.js"
    echo ""
    echo "📝 Next steps:"
    echo "  • Verify the npm package"
    echo "  • Test the CDN link"
    echo "  • Update examples to use new version"
}

main "$@"
