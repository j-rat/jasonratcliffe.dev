variable "aws_region" {
  description = "Region for all resources. us-east-1 is required for the CloudFront certificate."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix. Must match the bootstrap stack so the deploy role's scoped permissions apply."
  type        = string
  default     = "resume-site"
}

variable "domain_name" {
  description = "Apex domain. Its Route 53 zone is created by the bootstrap stack."
  type        = string
  default     = "jasonratcliffe.dev"
}

variable "contact_to_email" {
  description = "Inbox that receives contact-form messages. Never rendered on the site; pass via TF_VAR_contact_to_email."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.contact_to_email))
    error_message = "contact_to_email must be an email address."
  }
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 = North America + Europe edges (cheapest)."
  type        = string
  default     = "PriceClass_100"
}

variable "contact_rate_limit" {
  description = "Steady-state requests per second allowed on the contact API."
  type        = number
  default     = 1
}

variable "contact_burst_limit" {
  description = "Burst size for the contact API before it returns 429."
  type        = number
  default     = 5
}
