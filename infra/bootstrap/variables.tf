variable "aws_region" {
  description = "Region for all resources. us-east-1 is required for the CloudFront certificate."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for resources. Workload roles and buckets are scoped to this prefix."
  type        = string
  default     = "resume-site"
}

variable "domain_name" {
  description = "Apex domain served by the site."
  type        = string
  default     = "jasonratcliffe.dev"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the deploy roles, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use the form owner/repo."
  }
}

variable "github_ids" {
  description = "Numeric GitHub owner and repository IDs. Set them when the repo uses immutable OIDC subjects (gh api repos/OWNER/REPO/actions/oidc/customization/sub shows use_immutable_subject = true)."
  type = object({
    owner      = number
    repository = number
  })
  default = null
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the apply role."
  type        = string
  default     = "production"
}

variable "create_github_oidc_provider" {
  description = "Set false if the account already has the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = true
}

variable "activate_cost_tag" {
  description = "Activate the application cost allocation tag in Billing. Set true about 24 hours after the first apply that adds the tag: AWS refuses to activate a key it hasn't seen on any resource yet."
  type        = bool
  default     = false
}

variable "dnssec_signing" {
  description = "Sign the zone with DNSSEC. Before setting false, remove the DS record at the registrar and wait for its TTL."
  type        = bool
  default     = true
}
