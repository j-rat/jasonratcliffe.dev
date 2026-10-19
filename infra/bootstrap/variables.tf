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
