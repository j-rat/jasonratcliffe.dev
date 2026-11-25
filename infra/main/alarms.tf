# Alerts when nobody is watching: CloudWatch alarms email the contact inbox through SNS.
# The subscription stays "pending confirmation" until the link in AWS's first email is clicked (runbook, Alerts).
# Alarm and topic names must start with ${var.project}- (the apply role is scoped to that prefix).

resource "aws_sns_topic" "alerts" {
  #checkov:skip=CKV_AWS_26:CloudWatch can't publish to a topic encrypted with the AWS-managed key, and a CMK costs more than these alerts are worth; messages hold alarm names only
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.contact_to_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]

  lambda_alarms = {
    contact     = aws_lambda_function.contact.function_name
    edge-report = aws_lambda_function.edge_report.function_name
  }

  dnssec_alarms = {
    # Route 53 couldn't sign: fix within hours or validating resolvers stop resolving the domain.
    internal-failure = "DNSSECInternalFailure"
    # The KMS key behind the KSK is disabled, deleted or its policy no longer lets Route 53 use it.
    ksk-action-needed = "DNSSECKeySigningKeysNeedingAction"
  }
}

# Server errors seen by visitors (CloudFront reports these globally, in us-east-1).
resource "aws_cloudwatch_metric_alarm" "site_5xx" {
  alarm_name          = "${var.project}-site-5xx"
  alarm_description   = "More than 5% of requests to the site returned a server error for 15 minutes."
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  dimensions          = { DistributionId = aws_cloudfront_distribution.site.id, Region = "Global" }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.lambda_alarms
  alarm_name          = "${var.project}-${each.key}-errors"
  alarm_description   = "The ${each.key} Lambda raised an error. Check its log group for the outcome line."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "dnssec" {
  for_each            = local.dnssec_alarms
  alarm_name          = "${var.project}-dnssec-${each.key}"
  alarm_description   = "Route 53 DNSSEC: ${each.value}. Act quickly (docs/RUNBOOK.md, DNSSEC)."
  namespace           = "AWS/Route53"
  metric_name         = each.value
  dimensions          = { HostedZoneId = data.aws_route53_zone.site.zone_id }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
