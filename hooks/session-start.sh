#!/usr/bin/env bash
# Injects current Brain context into every Claude Code session (ARCHITECTURE.md §52.1).
node $HOME/Projects/central-brain/dist/cli/index.js context get --current --budget 30 2>/dev/null || true
