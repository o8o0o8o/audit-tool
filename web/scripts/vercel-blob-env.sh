#!/usr/bin/env bash
# Source this before calling upload-results.mjs on GitHub Actions.
#
# New Vercel Blob stores have no long-lived BLOB_READ_WRITE_TOKEN; they authenticate with
# BLOB_STORE_ID + a short-lived VERCEL_OIDC_TOKEN, which exist only on Vercel. This pulls
# both from the Vercel project's Development environment (OIDC token valid ~12h), so pull
# right before each upload. Skipped when a BLOB_READ_WRITE_TOKEN secret is set.
#
# Env: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID (GitHub secrets).
if [ -n "${BLOB_READ_WRITE_TOKEN:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
if [ -z "${VERCEL_TOKEN:-}" ] || [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ]; then
  echo "::error::set BLOB_READ_WRITE_TOKEN, or VERCEL_TOKEN + VERCEL_ORG_ID + VERCEL_PROJECT_ID"
  return 1 2>/dev/null || exit 1
fi
env_file="$(mktemp)"
npx --yes vercel@65.4.0 env pull "$env_file" --yes --environment=development --token="$VERCEL_TOKEN" >/dev/null
BLOB_STORE_ID="$(grep -E '^BLOB_STORE_ID=' "$env_file" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
VERCEL_OIDC_TOKEN="$(grep -E '^VERCEL_OIDC_TOKEN=' "$env_file" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
rm -f "$env_file"
if [ -z "$BLOB_STORE_ID" ] || [ -z "$VERCEL_OIDC_TOKEN" ]; then
  echo "::error::vercel env pull returned no BLOB_STORE_ID/VERCEL_OIDC_TOKEN (connect the Blob store to the Development environment and enable OIDC)"
  return 1 2>/dev/null || exit 1
fi
echo "::add-mask::$VERCEL_OIDC_TOKEN"
export BLOB_STORE_ID VERCEL_OIDC_TOKEN
