#!/usr/bin/env bash
# Print the resources a saved Terraform plan changes, as a sorted JSON list of [address, actions].
# checks.yml fingerprints this list before approval; deploy.yml re-plans and must get the same list.
# No-ops and data-source reads are left out. Usage: plan-changes.sh <planfile>
set -euo pipefail
terraform show -json "$1" | jq -c '
  [ .resource_changes[]?
    | select(.change.actions != ["no-op"] and .change.actions != ["read"])
    | [.address, .change.actions] ]
  | sort'
