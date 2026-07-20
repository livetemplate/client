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

    # Refuse to guess which [Unreleased] section is the real one. Release-note
    # extraction stops at the first heading, so a duplicate means one section can
    # never ship — and it stays invisible until someone reads the whole file.
    local unreleased_headings
    unreleased_headings=$(grep -c '^## \[Unreleased\]' CHANGELOG.md 2>/dev/null || true)
    if [ "${unreleased_headings:-0}" -gt 1 ]; then
        log_error "CHANGELOG.md has $unreleased_headings '## [Unreleased]' headings; there must be at most one"
        echo ""
        grep -n '^## \[Unreleased\]' CHANGELOG.md
        echo ""
        echo "Merge them into the topmost one, or retitle the stale section with the"
        echo "version it actually shipped in, then re-run."
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

# Restore the release-managed files if the run aborts between writing them and
# committing. Without this, a failure in verify_build, verify_package_contents or
# `gh release create` leaves VERSION, package.json, package-lock.json and
# CHANGELOG.md rewritten in the worktree — and main() refuses to start on a dirty
# tree, so the next attempt fails for a reason unrelated to why this one did.
release_files_written=false
release_committed=false

restore_release_files() {
    [ "$release_files_written" = true ] || return 0
    [ "$release_committed" = false ] || return 0

    log_warn "Release aborted before committing — restoring version and changelog files"

    # Restore from HEAD, not from the index: commit_and_tag stages these files
    # before committing, so if the commit itself fails they are already staged
    # and a plain `git checkout --` would restore them from the index — copying
    # the modified versions back over themselves.
    #
    # One path per invocation. `git checkout HEAD -- a b` resolves the pathspec
    # first and bails before touching the worktree if any entry is missing from
    # HEAD, so a single call would restore *none* of them when one is untracked.
    # git's stderr is left visible; a generic "couldn't restore" would send the
    # next person down the wrong trail.
    local f
    for f in VERSION package.json package-lock.json CHANGELOG.md; do
        if git cat-file -e "HEAD:$f" 2>/dev/null; then
            git checkout HEAD -- "$f" || \
                log_warn "Could not restore $f; revert it by hand before retrying"
        elif [ -f "$f" ]; then
            # Absent from HEAD but on disk means this run created it: main()
            # refuses to start on a dirty tree and `git status --porcelain`
            # lists untracked files, so it cannot have pre-existed. Removing it
            # restores the exact pre-run state. Both steps are needed —
            # commit_and_tag may already have staged it, and a bare `rm` would
            # leave an "A " entry that still counts as dirty.
            git rm -f --quiet --ignore-unmatch -- "$f" 2>/dev/null || true
            rm -f "$f"
            log_warn "Removed $f, which this run created"
        fi
    done
}
trap restore_release_files EXIT

# Update all version files
update_versions() {
    local new_version=$1

    log_step "Updating VERSION file to $new_version"
    release_files_written=true
    echo "$new_version" > VERSION

    log_step "Updating package.json to $new_version"
    npm version "$new_version" --no-git-tag-version --allow-same-version > /dev/null 2>&1

    log_info "All version files updated to $new_version"
}

# Print the body of the "## [Unreleased]" section — everything between that
# heading and the next "## [" heading.
unreleased_body() {
    awk '/^## \[Unreleased\]/ { inside = 1; next }
         inside && /^## \[/    { inside = 0 }
         inside                { print }' CHANGELOG.md 2>/dev/null || true
}

# Retitle "## [Unreleased]" as the release heading, leaving its content alone.
# Only the first match is rewritten; main() has already refused to proceed if
# there is more than one.
promote_unreleased() {
    local heading=$1

    awk -v heading="$heading" '
        /^## \[Unreleased\]/ && !promoted { print heading; promoted = 1; next }
        { print }' CHANGELOG.md > CHANGELOG.md.tmp
    mv CHANGELOG.md.tmp CHANGELOG.md
}

# Generate changelog
generate_changelog() {
    local new_version=$1
    local prev_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    log_step "Generating changelog for v$new_version"

    # Prefer what a human wrote. The file declares Keep a Changelog, whose whole
    # workflow is to maintain [Unreleased] and promote it on release — so a
    # curated section is the release notes, and regenerating over it throws away
    # the only description of the change anyone will read
    # (livetemplate/livetemplate#511).
    if [ -n "$(unreleased_body | tr -d '[:space:]')" ]; then
        log_info "Promoting the curated [Unreleased] section to v$new_version"
        promote_unreleased "## [v$new_version] - $(date +%Y-%m-%d)"
        return
    fi

    log_warn "No curated [Unreleased] content; falling back to a commit-subject list"

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

    # Set immediately after the commit: from here the changes live in history,
    # so restoring the worktree from HEAD would be a no-op at best and would
    # discard the release commit's content at worst.
    release_committed=true

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
    npm run clean || {
        log_error "Clean failed, aborting release"
        exit 1
    }

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
        if ! echo "$pack_output" | grep -qF "$f"; then
            log_error "npm pack missing required file: $f"
            exit 1
        fi
    done

    log_info "Package contents verified"
}

# NOTE: npm publishing is intentionally NOT done here.
# It runs in CI via .github/workflows/publish.yml, which is triggered by the
# GitHub release created at the end of this script. Authentication is handled
# by npm OIDC trusted publishing (no NPM_TOKEN secret required) and the
# resulting package gets a verified provenance attestation on npmjs.com.

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
    log_info "Would push to GitHub and create release"
    log_info "GitHub release would trigger CI workflow to publish @livetemplate/client@$new_version to npm"

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

    # Releases must come from main — auto-switch if the user is on a feature branch
    # (e.g. a PR branch that was squash-merged and deleted on origin).
    if [ "$branch" != "main" ]; then
        log_step "On branch '$branch' — switching to main (releases must come from main)"
        git checkout main || {
            log_error "Failed to check out main. Resolve manually before releasing."
            exit 1
        }
        branch="main"
        log_info "Switched to main"
    fi
    # Fetch origin/$branch and force-update the tracking ref so the
    # rev-list ahead/behind comparison below uses current remote state.
    # Plain `git fetch origin $branch` only updates FETCH_HEAD in some
    # git versions/configs, leaving refs/remotes/origin/$branch stale.
    log_step "Fetching origin/$branch to check sync state"
    if ! git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch" --quiet; then
        log_error "Could not fetch origin/$branch. Check your network connection."
        exit 1
    fi

    local behind ahead
    behind=$(git rev-list --count HEAD..origin/"$branch" 2>/dev/null || echo "0")
    ahead=$(git rev-list --count origin/"$branch"..HEAD 2>/dev/null || echo "0")

    if [ "$behind" -gt 0 ] && [ "$ahead" -gt 0 ]; then
        log_error "Branch has diverged from origin/$branch ($ahead ahead, $behind behind). Resolve manually before releasing."
        exit 1
    elif [ "$behind" -gt 0 ]; then
        if [ "$dry_run_mode" = true ]; then
            log_error "Local branch is $behind commit(s) behind origin/$branch. Pull and re-run."
            exit 1
        fi
        log_step "Fast-forwarding from origin/$branch ($behind new commit(s))"
        git merge --ff-only "origin/$branch" || {
            log_error "Fast-forward failed. Resolve manually before releasing."
            exit 1
        }
        log_info "Up to date with origin/$branch"
    elif [ "$ahead" -gt 0 ]; then
        log_warn "Local branch is $ahead commit(s) ahead of origin/$branch:"
        git log --oneline "origin/$branch..HEAD"
        echo ""
        if [ "$dry_run_mode" = true ]; then
            log_warn "Dry run: would prompt to push these commits before releasing"
        else
            read -rp "Push these commits to origin/$branch and continue with release? [y/N]: " push_confirm
            if [[ ! $push_confirm =~ ^[Yy]$ ]]; then
                log_warn "Release cancelled. Consider opening a PR for these commits and re-run when merged."
                exit 0
            fi
            log_step "Pushing local commits to origin/$branch"
            git push origin "$branch" || {
                log_error "Failed to push to origin/$branch."
                exit 1
            }
            log_info "Pushed $ahead commit(s) to origin/$branch"
        fi
    else
        log_info "Branch is up to date with origin/$branch"
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
    echo "  • Create GitHub release with release notes"
    echo "  • Trigger CI workflow to publish @livetemplate/client@$new_version to npm"
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

    # Execute release steps. Note: npm publish runs in CI (publish.yml),
    # triggered by the GitHub release created in publish_github below.
    # Tests and the build run first, on the pre-bump tree, so a failing test
    # aborts before VERSION/package.json/CHANGELOG.md are touched at all. The
    # dist bundle embeds no version string, so building ahead of the bump is
    # equivalent. verify_build still runs after, since it asserts package.json
    # carries the new version.
    build_and_test
    update_versions "$new_version"
    generate_changelog "$new_version"
    verify_build "$new_version"
    verify_package_contents
    commit_and_tag "$new_version"
    publish_github "$new_version"

    echo ""
    echo "================================================"
    log_info "✨ Release v$new_version tagged and pushed!"
    echo "================================================"
    echo ""
    echo "📦 GitHub release: https://github.com/livetemplate/client/releases/tag/v$new_version"
    echo ""
    echo "🤖 npm publish runs on CI (triggered by the GitHub release):"
    echo "   https://github.com/livetemplate/client/actions/workflows/publish.yml"
    echo ""
    echo "Once the workflow finishes, the package will be available at:"
    echo "   • npm: https://www.npmjs.com/package/@livetemplate/client/v/$new_version"
    echo "   • CDN: https://cdn.jsdelivr.net/npm/@livetemplate/client@$new_version/dist/livetemplate-client.browser.js"
    echo ""
    echo "📝 Next steps:"
    echo "  • Watch the Actions tab and confirm the Publish workflow succeeds"
    echo "  • Verify the npm package once published"
    echo "  • Update examples to use new version"
}

# Sourced with RELEASE_SH_LIB=1 by scripts/test_release_changelog.sh, which
# exercises the changelog functions without running a release.
if [ -z "${RELEASE_SH_LIB:-}" ]; then
    main "$@"
fi
