#!/bin/bash

# Install git hooks for LiveTemplate Client

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_DIR="$(git rev-parse --git-dir)"

echo "📦 Installing git hooks..."

# Install pre-commit hook
if [ -f "$SCRIPT_DIR/pre-commit.sh" ]; then
    cp "$SCRIPT_DIR/pre-commit.sh" "$GIT_DIR/hooks/pre-commit"
    chmod +x "$GIT_DIR/hooks/pre-commit"
    echo "✅ Pre-commit hook installed"
else
    echo "❌ pre-commit.sh not found in $SCRIPT_DIR"
    exit 1
fi

echo "✅ Git hooks installed successfully"
echo ""
echo "To skip hooks during commit (not recommended), use:"
echo "  git commit --no-verify"
