# DNSSEC signing for the public zone. Route 53 manages the zone-signing key; the key-signing key (KSK) is
# backed by this asymmetric KMS key, which must be ECC_NIST_P256 in us-east-1.
#
# Signing alone changes nothing for visitors. The chain of trust starts when the DS record from the
# `dnssec_ds_record` output is added at the registrar, and that step comes last (docs/RUNBOOK.md, DNSSEC).
# To turn DNSSEC off, remove the DS record at the registrar FIRST, wait for its TTL, then set
# dnssec_signing = false. Never delete this key while a DS record points at it: the domain stops resolving
# for validating resolvers.

data "aws_iam_policy_document" "dnssec_key" {
  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "Route53DnssecUsesKey"
    actions   = ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["dnssec-route53.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:route53:::hostedzone/*"]
    }
  }

  statement {
    sid       = "Route53DnssecGrant"
    actions   = ["kms:CreateGrant"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["dnssec-route53.amazonaws.com"]
    }
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_kms_key" "dnssec" { # nosemgrep: terraform.aws.security.aws-kms-no-rotation.aws-kms-no-rotation
  #checkov:skip=CKV_AWS_7:Asymmetric signing keys can't use KMS automatic rotation; KSK rotation is a Route 53 procedure (runbook)
  description              = "DNSSEC key-signing key for ${var.domain_name}"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.dnssec_key.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "dnssec" {
  name          = "alias/${var.project}-dnssec"
  target_key_id = aws_kms_key.dnssec.key_id
}

resource "aws_route53_key_signing_key" "site" {
  hosted_zone_id             = aws_route53_zone.site.zone_id
  key_management_service_arn = aws_kms_key.dnssec.arn
  name                       = "${replace(var.project, "-", "_")}_ksk" # letters, digits and underscores only
}

resource "aws_route53_hosted_zone_dnssec" "site" {
  hosted_zone_id = aws_route53_key_signing_key.site.hosted_zone_id
  signing_status = var.dnssec_signing ? "SIGNING" : "NOT_SIGNING"
}
