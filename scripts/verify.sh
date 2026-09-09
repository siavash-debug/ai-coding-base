#!/usr/bin/env bash
set -euo pipefail

echo "1/7 dependency installation"
pnpm install --frozen-lockfile

echo "2/7 format:check"
pnpm format:check

echo "3/7 lint"
pnpm lint

echo "4/7 typecheck"
pnpm typecheck

echo "5/7 unit tests"
pnpm test

echo "6/7 build"
pnpm build

echo "7/7 execute built artifact"
node ./dist/index.js

# Phase B hook (deferred): evals/, Python, Docker extend here without reordering.
