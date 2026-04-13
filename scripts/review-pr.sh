#!/usr/bin/env bash
set -euo pipefail

# review-pr.sh — Code review using Claude Code subscription (no API key needed)
# Usage:
#   ./scripts/review-pr.sh 42                     # PR number in current repo
#   ./scripts/review-pr.sh 42 --repo owner/repo   # PR in a specific repo
#   ./scripts/review-pr.sh 42 --post              # Post review as PR comment
#   ./scripts/review-pr.sh 42 --focus security    # Focus area: security|performance|bugs|all

PR_NUMBER=""
REPO_FLAG=""
POST=false
FOCUS="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO_FLAG="--repo $2"; shift 2 ;;
    --post)   POST=true; shift ;;
    --focus)  FOCUS="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: review-pr.sh <pr-number> [--repo owner/repo] [--post] [--focus security|performance|bugs|all]"
      echo ""
      echo "Options:"
      echo "  --repo    Target a specific repo (default: current repo)"
      echo "  --post    Post the review as a PR comment"
      echo "  --focus   Focus area: security, performance, bugs, all (default: all)"
      exit 0
      ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then
        PR_NUMBER="$1"
      else
        echo "Error: unexpected argument '$1'" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$PR_NUMBER" ]]; then
  echo "Error: PR number required" >&2
  echo "Usage: review-pr.sh <pr-number> [--repo owner/repo] [--post] [--focus security|performance|bugs|all]" >&2
  exit 1
fi

# Check dependencies
command -v gh >/dev/null 2>&1 || { echo "Error: gh CLI not found. Install: https://cli.github.com" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: claude CLI not found." >&2; exit 1; }

# Fetch PR metadata
echo "Fetching PR #${PR_NUMBER}..." >&2
PR_TITLE=$(gh pr view "$PR_NUMBER" $REPO_FLAG --json title --jq '.title' 2>/dev/null) || {
  echo "Error: could not fetch PR #${PR_NUMBER}. Check the number and repo." >&2
  exit 1
}
PR_BODY=$(gh pr view "$PR_NUMBER" $REPO_FLAG --json body --jq '.body // ""')
PR_FILES=$(gh pr view "$PR_NUMBER" $REPO_FLAG --json files --jq '.files[].path' | head -50)
DIFF=$(gh pr diff "$PR_NUMBER" $REPO_FLAG)

if [[ -z "$DIFF" ]]; then
  echo "Error: empty diff for PR #${PR_NUMBER}" >&2
  exit 1
fi

DIFF_LINES=$(echo "$DIFF" | wc -l | tr -d ' ')
echo "PR: $PR_TITLE ($DIFF_LINES lines of diff)" >&2

# Build focus instruction
case "$FOCUS" in
  security)    FOCUS_INSTRUCTION="Focus specifically on security vulnerabilities: injection, auth issues, data exposure, unsafe operations." ;;
  performance) FOCUS_INSTRUCTION="Focus specifically on performance issues: N+1 queries, unnecessary allocations, blocking operations, algorithmic complexity." ;;
  bugs)        FOCUS_INSTRUCTION="Focus specifically on correctness bugs: off-by-one errors, null/undefined access, race conditions, logic errors." ;;
  all)         FOCUS_INSTRUCTION="Review for bugs, security issues, performance problems, and code quality." ;;
  *)           echo "Error: unknown focus '$FOCUS'. Use: security, performance, bugs, all" >&2; exit 1 ;;
esac

# Build the prompt
PROMPT=$(cat <<'PROMPT_END'
You are reviewing a pull request. Be direct and concise.

## PR Info
- Title: ${PR_TITLE}
- Description: ${PR_BODY}
- Files changed: ${PR_FILES}

## Instructions
${FOCUS_INSTRUCTION}

Rules:
- Only flag real, actionable issues. No nitpicks unless they cause bugs.
- For each issue, state: file, line number (from the diff), severity (bug/security/performance/style), and a one-line fix suggestion.
- If the PR looks good, say so briefly. Don't invent problems.
- Keep the review under 500 words unless there are many real issues.

## Diff
PROMPT_END
)

# Substitute variables (heredoc above uses single quotes to prevent premature expansion)
PROMPT="${PROMPT//\$\{PR_TITLE\}/$PR_TITLE}"
PROMPT="${PROMPT//\$\{PR_BODY\}/$PR_BODY}"
PROMPT="${PROMPT//\$\{PR_FILES\}/$PR_FILES}"
PROMPT="${PROMPT//\$\{FOCUS_INSTRUCTION\}/$FOCUS_INSTRUCTION}"

# Truncate large diffs to avoid blowing context
MAX_DIFF_LINES=3000
if [[ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]]; then
  echo "Warning: diff is $DIFF_LINES lines, truncating to $MAX_DIFF_LINES" >&2
  DIFF=$(echo "$DIFF" | head -"$MAX_DIFF_LINES")
  PROMPT="${PROMPT}
(diff truncated to ${MAX_DIFF_LINES} lines — review may be incomplete)"
fi

FULL_INPUT="${PROMPT}
${DIFF}"

# Run review
echo "Running review..." >&2
REVIEW=$(echo "$FULL_INPUT" | claude -p --output-format text)

# Output
echo ""
echo "$REVIEW"

# Optionally post as PR comment
if [[ "$POST" == true ]]; then
  echo "" >&2
  echo "Posting review to PR #${PR_NUMBER}..." >&2
  COMMENT_BODY=$(cat <<EOF
## Claude Code Review

$REVIEW

---
*Reviewed with Claude Code CLI*
EOF
)
  gh pr comment "$PR_NUMBER" $REPO_FLAG --body "$COMMENT_BODY"
  echo "Posted." >&2
fi
