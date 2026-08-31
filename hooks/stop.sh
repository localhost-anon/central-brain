#!/usr/bin/env bash
# Reminds the agent to persist pending Brain state before the session ends or compacts (ARCHITECTURE.md §52.1).
echo "Central Brain: before finishing, persist pending state — record decisions (brain decision add), observations (brain observe), learnings (brain learning add), update work-unit statuses, and verify/complete the active goal if its criteria are met."
