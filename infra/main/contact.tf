# POST /api/contact  ->  CloudFront  ->  HTTP API (throttled)  ->  Lambda  ->  SES

data "archive_file" "contact" {
  type        = "zip"
  source_file = "${path.module}/lambda/contact/handler.py"
  output_path = "${path.module}/build/contact.zip"
}

data "aws_iam_policy_document" "contact_trust" {
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

resource "aws_iam_role" "contact" {
  name                 = "${var.project}-contact"
  description          = "Contact form Lambda: write its own logs, send mail from the site identity only."
  assume_role_policy   = data.aws_iam_policy_document.contact_trust.json
  permissions_boundary = data.aws_iam_policy.workload_boundary.arn
}

resource "aws_cloudwatch_log_group" "contact" {
  name              = "/aws/lambda/${var.project}-contact"
  retention_in_days = 30
}

data "aws_iam_policy_document" "contact" {
  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.contact.arn}:*"]
  }

  statement {
    sid     = "SendFromSiteIdentityToOwnerOnly"
    actions = ["ses:SendEmail"]
    resources = [
      aws_sesv2_email_identity.domain.arn,
      aws_sesv2_email_identity.recipient.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.from_address]
    }
  }
}

resource "aws_iam_role_policy" "contact" {
  name   = "contact-least-privilege"
  role   = aws_iam_role.contact.id
  policy = data.aws_iam_policy_document.contact.json
}

resource "aws_lambda_function" "contact" {
  function_name    = "${var.project}-contact"
  description      = "Validates contact-form submissions and forwards them via SES."
  role             = aws_iam_role.contact.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "handler.lambda_handler"
  filename         = data.archive_file.contact.output_path
  source_code_hash = data.archive_file.contact.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      TO_ADDRESS     = var.contact_to_email
      FROM_ADDRESS   = local.from_address
      FROM_NAME      = "${var.domain_name} contact form"
      SITE_ORIGIN    = "https://${var.domain_name}"
      ORIGIN_SECRET  = random_password.origin_verify.result
      SUBJECT_PREFIX = "[${var.domain_name}]"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.contact.name
  }

  depends_on = [aws_iam_role_policy.contact]
}

resource "aws_apigatewayv2_api" "contact" {
  name          = "${var.project}-contact"
  description   = "Contact form API, reachable only through CloudFront (origin secret)."
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "contact" {
  api_id                 = aws_apigatewayv2_api.contact.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.contact.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "contact" {
  api_id    = aws_apigatewayv2_api.contact.id
  route_key = "POST /api/contact"
  target    = "integrations/${aws_apigatewayv2_integration.contact.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.contact.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.contact_rate_limit
    throttling_burst_limit = var.contact_burst_limit
  }
}

resource "aws_lambda_permission" "contact_api" {
  statement_id  = "AllowContactApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.contact.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.contact.execution_arn}/${aws_apigatewayv2_stage.default.name}/POST/api/contact"
}
