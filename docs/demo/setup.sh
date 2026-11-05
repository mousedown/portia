#!/usr/bin/env bash
# The throwaway world docs/demo/install.tape records in: an empty home, and one small
# repository with a GitHub origin and real scripts. Nothing outside /tmp/you is touched.
set -euo pipefail
rm -rf /tmp/you
mkdir -p /tmp/you/your-repo/.github/workflows
cd /tmp/you/your-repo
git init -q
git remote add origin git@github.com:acme/widget.git
cat >package.json <<'JSON'
{ "scripts": { "lint": "biome check .", "typecheck": "tsc --noEmit", "test": "vitest run", "build": "tsc" } }
JSON
touch bun.lock .github/workflows/ci.yml
