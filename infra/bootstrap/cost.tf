# Cost allocation tag for the admin log viewer's cost view. Every resource in both stacks carries
# application = "resume" (provider default_tags); activating the key makes Cost Explorer able to filter on it.
# Activation needs the management (payer) account and only works once Billing has seen the key.
resource "aws_ce_cost_allocation_tag" "application" {
  count   = var.activate_cost_tag ? 1 : 0
  tag_key = "application"
  status  = "Active"
}
