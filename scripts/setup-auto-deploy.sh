#!/usr/bin/env bash
# One-time setup for automatic deployment from GitHub Actions.
# Run in Google Cloud Shell, from the repo folder, AFTER you have logged in to
# clasp and deployed the worker once (the steps in README → Deploy):
#
#   cd ~/Emailing && git pull && bash scripts/setup-auto-deploy.sh
#
# It creates a deploy service account for Firebase and stores three GitHub
# secrets: FIREBASE_SERVICE_ACCOUNT, CLASPRC_JSON and CLASP_SCRIPT_ID.
set -euo pipefail

PROJECT="${FIREBASE_PROJECT:-emailing-portal}"
SA_NAME="github-deployer"
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$(mktemp)"
trap 'rm -f "$KEY"' EXIT

echo "== 1/4 Checking clasp login and script ID"
CLASPRC="$HOME/.clasprc.json"
if [ ! -s "$CLASPRC" ]; then
  echo "Not logged in to clasp. Run: npx -y @google/clasp@latest login --no-localhost   then re-run this script."
  exit 1
fi
if [ ! -s "$ROOT/apps-script/.clasp.json" ]; then
  echo "apps-script/.clasp.json not found. Do the one-time 'clasp create' step in the README first."
  exit 1
fi
SCRIPT_ID="$(node -e "console.log(require('$ROOT/apps-script/.clasp.json').scriptId)")"
echo "   Script ID: $SCRIPT_ID"

echo "== 2/4 Creating deploy service account $SA"
gcloud config set project "$PROJECT" >/dev/null
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "GitHub Actions deployer"
for ROLE in roles/firebase.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$ROLE" --condition=None >/dev/null
done
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA"

echo "== 3/4 Connecting to GitHub"
if ! command -v gh >/dev/null 2>&1; then
  echo "Installing the GitHub CLI…"
  mkdir -p "$HOME/.local/bin"
  VER="$(curl -s https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p')"
  curl -sL "https://github.com/cli/cli/releases/download/v$VER/gh_${VER}_linux_amd64.tar.gz" | tar xz -C "$HOME/.local"
  ln -sf "$HOME/.local/gh_${VER}_linux_amd64/bin/gh" "$HOME/.local/bin/gh"
  export PATH="$HOME/.local/bin:$PATH"
fi
gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web

echo "== 4/4 Saving GitHub secrets"
cd "$ROOT"
gh secret set FIREBASE_SERVICE_ACCOUNT < "$KEY"
gh secret set CLASPRC_JSON < "$CLASPRC"
printf '%s' "$SCRIPT_ID" | gh secret set CLASP_SCRIPT_ID

echo
echo "Done. Every push to GitHub now tests and deploys the whole system automatically."
echo "Watch runs at: $(gh repo view --json url -q .url)/actions"
