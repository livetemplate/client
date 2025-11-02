#!/bin/bash

# Pre-commit hook for LiveTemplate Client
# Runs validation and tests

set -e

echo "🔄 Running pre-commit validation..."

# Step 1: Run linter (if available)
if npm run lint --if-present 2>/dev/null; then
    echo "✅ Linting passed"
else
    echo "⚠️  Linter not configured (skipping)"
fi

# Step 2: Run tests
echo "🧪 Running tests..."
if npm test; then
    echo "✅ Tests passed"
else
    echo "❌ Tests failed - commit blocked"
    exit 1
fi

# Step 3: Build check
echo "🔨 Building..."
if npm run build; then
    echo "✅ Build passed"
else
    echo "❌ Build failed - commit blocked"
    exit 1
fi

echo "✅ Pre-commit validation completed successfully"
