#!/usr/bin/env bash
#
# Refuses to let an agent, tool or bot identity author this repository's commits.
#
# See AGENTS.md section 8.1 and docs/architecture/DECISIONS.md ADR-044.
#
# Usage:
#   bash scripts/check-git-identity.sh
#   pnpm git:identity
#
# Optional strict mode, for a machine or hook that knows the owner's identity:
#   AI_GIT_EXPECTED_NAME="Siavash" \
#   AI_GIT_EXPECTED_EMAIL="siavashsafi76@gmail.com" \
#   bash scripts/check-git-identity.sh
#
# Installing it as a client-side pre-commit hook (opt-in, per clone):
#   printf '#!/usr/bin/env bash\nexec bash scripts/check-git-identity.sh\n' \
#     > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# Deliberately NOT part of scripts/verify.sh: CI runs under the runner's own
# identity (github-actions[bot]) and never commits, so checking identity there
# would fail for a reason that has nothing to do with the change under test.
#
# Honest limits: a GitHub noreply address passes, because it can be a genuine
# owner identity; "never invent one" is a rule this check documents rather than
# something a string match can enforce. The check also cannot prove the identity
# *is* the owner's - only that it is not an agent, tool or bot.
#
# Invoke it with an explicit interpreter (`bash script`), as CI does for
# scripts/verify.sh: with core.autocrlf enabled, a checkout on another platform
# may hand a shell a CRLF shebang line.
set -euo pipefail

# Agent, tool and bot markers. Matched case-insensitively against both the name
# and the email. Occurrence anywhere is enough: no legitimate human identity for
# this repository contains these strings.
FORBIDDEN_MARKERS='freebuff|codebuff|claude|copilot|dependabot|renovate|github-actions|githubactions|aider|cursor-agent|openai|anthropic|gemini|\[bot\]'

# A bare "bot" token, delimited so that a human surname such as "Talbot" passes.
BARE_BOT_TOKEN='(^|[-_.])bot([-_.@]|$)'

name="$(git config user.name || true)"
email="$(git config user.email || true)"

if [ -z "$name" ] || [ -z "$email" ]; then
  echo "FAIL: git user.name and git user.email must both be set."
  if [ -z "$name" ]; then echo "  user.name  is unset"; fi
  if [ -z "$email" ]; then echo "  user.email is unset"; fi
  echo "  Set the repository owner's GitHub identity, or do not commit."
  echo "  Do not invent or guess an address to satisfy this check."
  exit 1
fi

echo "user.name : ${name}"
echo "user.email: ${email}"

lower_name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
lower_email="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"
combined="${lower_name}
${lower_email}"

if printf '%s\n' "$combined" | grep -Eq "$FORBIDDEN_MARKERS"; then
  echo "FAIL: the configured identity looks like an agent, tool or bot identity."
  echo "  Commits for this repository must use the repository owner's GitHub identity."
  echo "  See AGENTS.md section 8.1 and docs/architecture/DECISIONS.md ADR-044."
  echo "  The local Git configuration was NOT modified by this check."
  exit 1
fi

if printf '%s\n' "$combined" | grep -Eq "$BARE_BOT_TOKEN"; then
  echo "FAIL: the configured identity looks like a bot identity."
  echo "  See AGENTS.md section 8.1 and docs/architecture/DECISIONS.md ADR-044."
  exit 1
fi

if [ -n "${AI_GIT_EXPECTED_NAME:-}" ] && [ "$name" != "$AI_GIT_EXPECTED_NAME" ]; then
  echo "FAIL: user.name is \"${name}\", but this environment expects \"${AI_GIT_EXPECTED_NAME}\"."
  exit 1
fi

if [ -n "${AI_GIT_EXPECTED_EMAIL:-}" ] && [ "$email" != "$AI_GIT_EXPECTED_EMAIL" ]; then
  echo "FAIL: user.email is \"${email}\", but this environment expects \"${AI_GIT_EXPECTED_EMAIL}\"."
  exit 1
fi

echo "OK: identity is not an agent, tool or bot identity."
echo "This check does not prove the identity belongs to the repository owner;"
echo "confirm that yourself before committing (see AGENTS.md section 8.1)."
