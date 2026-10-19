# GitHub Actions -> AWS with OIDC. No access keys exist anywhere.
#
#   plan role   assumable only by pull_request jobs in this repo; read-only + state lock
#   apply role  assumable only by jobs in the protected GitHub environment
#
# Workload roles the apply role creates (e.g. the contact Lambda's role) must carry the
# permissions boundary below, so a compromised pipeline cannot mint an admin role.

locals {
  oidc_host        = "token.actions.githubusercontent.com"
  oidc_provider    = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.oidc_host}"
  workload_prefix  = var.project
  region_account   = "${var.aws_region}:${local.account_id}"
  state_bucket_arn = aws_s3_bucket.state.arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

# ---------------------------------------------------------------------------
# Trust policies
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "trust_plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

data "aws_iam_policy_document" "trust_apply" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

# ---------------------------------------------------------------------------
# Shared: state access for the main stack only (key prefix main/)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "state_access" {
  statement {
    sid       = "ListStateBucket"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["main/*"]
    }
  }
  statement {
    sid       = "ReadWriteMainStateAndLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_bucket_arn}/main/*"]
  }
}

resource "aws_iam_policy" "state_access" {
  name        = "gha-${var.project}-state-access"
  description = "Read/write the main stack Terraform state and lock file."
  policy      = data.aws_iam_policy_document.state_access.json
}

# ---------------------------------------------------------------------------
# Plan role (pull requests)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "plan" {
  name                 = "gha-${var.project}-plan"
  description          = "GitHub Actions: terraform plan on pull requests (read-only)."
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "plan_state" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.state_access.arn
}

# ---------------------------------------------------------------------------
# Permissions boundary for every workload role the pipeline creates
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "workload_boundary" {
  statement {
    sid       = "LambdaLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region_account}:log-group:/aws/lambda/${local.workload_prefix}-*:*"]
  }
  statement {
    sid       = "SendMailOnly"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["arn:${local.partition}:ses:${local.region_account}:identity/*"]
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = "boundary-${var.project}-workload"
  description = "Ceiling for roles created by the deploy pipeline: Lambda logs and SES send only."
  policy      = data.aws_iam_policy_document.workload_boundary.json
}

# ---------------------------------------------------------------------------
# Apply role (protected environment on main)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy" {
  statement {
    sid     = "SiteBuckets"
    actions = ["s3:*"]
    resources = [
      "arn:${local.partition}:s3:::${local.workload_prefix}-origin-*",
      "arn:${local.partition}:s3:::${local.workload_prefix}-origin-*/*",
    ]
  }

  statement {
    sid       = "CloudFront"
    actions   = ["cloudfront:*"]
    resources = ["*"] # CloudFront IDs are not known before creation.
  }

  statement {
    sid = "Certificates"
    actions = [
      "acm:RequestCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate", "acm:GetCertificate",
      "acm:ListCertificates", "acm:ListTagsForCertificate", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid = "DnsRecordsInSiteZoneOnly"
    actions = [
      "route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets",
      "route53:GetHostedZone", "route53:ListTagsForResource",
    ]
    resources = [aws_route53_zone.site.arn]
  }

  statement {
    sid       = "DnsRead"
    actions   = ["route53:GetChange", "route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:ListTagsForResources"]
    resources = ["*"]
  }

  statement {
    sid       = "Email"
    actions   = ["ses:*"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "ContactFunction"
    actions   = ["lambda:*"]
    resources = ["arn:${local.partition}:lambda:${local.region_account}:function:${local.workload_prefix}-*"]
  }

  statement {
    sid     = "ContactApi"
    actions = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE", "apigateway:TagResource", "apigateway:UntagResource"]
    resources = [
      "arn:${local.partition}:apigateway:${var.aws_region}::/apis",
      "arn:${local.partition}:apigateway:${var.aws_region}::/apis/*",
      "arn:${local.partition}:apigateway:${var.aws_region}::/tags/*",
    ]
  }

  statement {
    sid = "FunctionLogGroups"
    actions = [
      "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
      "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource", "logs:TagLogGroup", "logs:ListTagsLogGroup",
    ]
    resources = [
      "arn:${local.partition}:logs:${local.region_account}:log-group:/aws/lambda/${local.workload_prefix}-*",
      "arn:${local.partition}:logs:${local.region_account}:log-group:/aws/lambda/${local.workload_prefix}-*:*",
    ]
  }

  statement {
    sid       = "LogsRead"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid       = "CreateWorkloadRolesOnlyWithBoundary"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRolePolicy"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.workload_prefix}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.workload_boundary.arn]
    }
  }

  statement {
    sid = "ManageWorkloadRoles"
    actions = [
      "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:DeleteRole", "iam:TagRole", "iam:UntagRole",
      "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.workload_prefix}-*"]
  }

  statement {
    sid       = "PassWorkloadRolesToLambdaOnly"
    actions   = ["iam:PassRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.workload_prefix}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadBoundary"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = [aws_iam_policy.workload_boundary.arn]
  }

  statement {
    sid    = "NeverWeakenGuardrails"
    effect = "Deny"
    actions = [
      "iam:DeleteRolePermissionsBoundary",
      "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ProtectStateBucketConfig"
    effect    = "Deny"
    actions   = ["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration", "s3:PutBucketPublicAccessBlock"]
    resources = [local.state_bucket_arn]
  }
}

resource "aws_iam_policy" "deploy" {
  name        = "gha-${var.project}-deploy"
  description = "Everything the main stack and site deploy need, scoped to the ${var.project} prefix."
  policy      = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role" "apply" {
  name                 = "gha-${var.project}-apply"
  description          = "GitHub Actions: terraform apply and site deploy from the ${var.github_environment} environment."
  assume_role_policy   = data.aws_iam_policy_document.trust_apply.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "apply_deploy" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.deploy.arn
}

resource "aws_iam_role_policy_attachment" "apply_state" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.state_access.arn
}
