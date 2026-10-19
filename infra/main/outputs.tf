# Resource identifiers are marked sensitive so they never print in CI logs.
# The deploy workflow reads them with `terraform output -raw` and masks them.

output "site_url" {
  value = "https://${var.domain_name}"
}

output "site_bucket" {
  value     = aws_s3_bucket.origin.bucket
  sensitive = true
}

output "distribution_id" {
  value     = aws_cloudfront_distribution.site.id
  sensitive = true
}

output "ses_recipient_verification" {
  description = "Recipient verification state. If not SUCCESS, click the link AWS emailed to the contact inbox."
  value       = aws_sesv2_email_identity.recipient.verified_for_sending_status ? "verified" : "pending: check the contact inbox for an AWS verification email"
}
