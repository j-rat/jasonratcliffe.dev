data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_route53_zone" "site" {
  name         = var.domain_name
  private_zone = false
}

# Created by the bootstrap stack; every role this stack creates must carry it.
data "aws_iam_policy" "workload_boundary" {
  name = "boundary-${var.project}-workload"
}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  www_domain   = "www.${var.domain_name}"
  from_address = "noreply@${var.domain_name}"
  mail_from    = "mail.${var.domain_name}"
}

resource "random_id" "origin_suffix" {
  byte_length = 4
}

# Shared secret CloudFront adds to API requests; the Lambda rejects calls without it,
# so the execute-api endpoint is useless if someone finds it.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}
