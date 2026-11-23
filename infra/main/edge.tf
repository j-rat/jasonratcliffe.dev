# CloudFront access logs -> CloudWatch Logs -> daily summary Lambda -> s3://<origin>/data/edge-threats.json -> /edge/
# Viewer IPs, X-Forwarded-For and cookies are never logged (record_fields), so they can't be published.

resource "aws_cloudwatch_log_group" "edge_access" {
  name              = "/aws/vendedlogs/${var.project}-cloudfront"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_delivery_source" "edge" {
  name         = "${var.project}-cloudfront"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
}

resource "aws_cloudwatch_log_delivery_destination" "edge" {
  name          = "${var.project}-cloudfront"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.edge_access.arn
  }
}

resource "aws_cloudwatch_log_delivery" "edge" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.edge.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.edge.arn
  record_fields = [
    "timestamp", "cs-method", "cs(Host)", "cs-uri-stem", "cs-uri-query",
    "sc-status", "cs(User-Agent)", "c-country", "x-edge-result-type",
  ]
}

data "archive_file" "edge_report" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/edge_report"
  excludes    = ["test_handler.py", "__pycache__"]
  output_path = "${path.module}/build/edge_report.zip"
}

data "aws_iam_policy_document" "edge_report_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "edge_report" {
  name                 = "${var.project}-edge-report"
  description          = "Edge report Lambda: query CloudFront access logs, publish data/edge-threats.json."
  assume_role_policy   = data.aws_iam_policy_document.edge_report_trust.json
  permissions_boundary = data.aws_iam_policy.workload_boundary.arn
}

resource "aws_cloudwatch_log_group" "edge_report" {
  name              = "/aws/lambda/${var.project}-edge-report"
  retention_in_days = 30
}

data "aws_iam_policy_document" "edge_report" {
  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.edge_report.arn}:*"]
  }

  statement {
    sid     = "QueryAccessLogs"
    actions = ["logs:StartQuery"]
    resources = [
      aws_cloudwatch_log_group.edge_access.arn,
      "${aws_cloudwatch_log_group.edge_access.arn}:*",
    ]
  }

  statement {
    sid       = "ReadQueryResults"
    actions   = ["logs:GetQueryResults", "logs:StopQuery"]
    resources = ["*"] # no resource-level support
  }

  statement {
    sid       = "PublishSummaryOnly"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.origin.arn}/data/edge-threats.json"]
  }
}

resource "aws_iam_role_policy" "edge_report" {
  name   = "edge-report-least-privilege"
  role   = aws_iam_role.edge_report.id
  policy = data.aws_iam_policy_document.edge_report.json
}

resource "aws_lambda_function" "edge_report" {
  function_name    = "${var.project}-edge-report"
  description      = "Daily summary of probe traffic in the CloudFront access logs, published for /edge/."
  role             = aws_iam_role.edge_report.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "handler.lambda_handler"
  filename         = data.archive_file.edge_report.output_path
  source_code_hash = data.archive_file.edge_report.output_base64sha256
  timeout          = 120 # Logs Insights queries are polled
  memory_size      = 256

  environment {
    variables = {
      LOG_GROUP  = aws_cloudwatch_log_group.edge_access.name
      BUCKET     = aws_s3_bucket.origin.id
      OBJECT_KEY = "data/edge-threats.json"
      SITE_HOST  = var.domain_name
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.edge_report.name
  }

  depends_on = [aws_iam_role_policy.edge_report]
}

resource "aws_cloudwatch_event_rule" "edge_report_daily" {
  name                = "${var.project}-edge-report-daily"
  description         = "Summarize the previous day's CloudFront access logs for /edge/."
  schedule_expression = "cron(15 0 * * ? *)" # 00:15 UTC daily
}

resource "aws_cloudwatch_event_target" "edge_report" {
  rule = aws_cloudwatch_event_rule.edge_report_daily.name
  arn  = aws_lambda_function.edge_report.arn
}

resource "aws_lambda_permission" "edge_report_schedule" {
  statement_id  = "AllowDailySchedule"
  action        = "lambda:InvokeFunction"
  principal     = "events.amazonaws.com"
  function_name = aws_lambda_function.edge_report.function_name
  source_arn    = aws_cloudwatch_event_rule.edge_report_daily.arn
}
