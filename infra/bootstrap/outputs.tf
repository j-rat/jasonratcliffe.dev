output "state_bucket" {
  description = "Put this in GitHub secret TF_STATE_BUCKET and in ../backend.hcl."
  value       = aws_s3_bucket.state.bucket
}

output "plan_role_arn" {
  description = "GitHub secret AWS_PLAN_ROLE_ARN."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "GitHub secret AWS_APPLY_ROLE_ARN (environment secret on 'production')."
  value       = aws_iam_role.apply.arn
}

output "workload_boundary_arn" {
  description = "Permissions boundary the main stack attaches to every role it creates."
  value       = aws_iam_policy.workload_boundary.arn
}

output "route53_nameservers" {
  description = "Paste these four values into Squarespace > Domains > DNS > Nameservers > Use custom nameservers."
  value       = aws_route53_zone.site.name_servers
}
