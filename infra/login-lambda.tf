locals {
  login_lambda_name = "agentic-sdlc-lab-login"
}

data "archive_file" "login_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src/lambdas/login"
  output_path = "${path.module}/../build/lambdas/login.zip"
}

resource "aws_iam_role" "login_lambda" {
  name = "${local.login_lambda_name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "login_lambda" {
  name              = "/aws/lambda/${local.login_lambda_name}"
  retention_in_days = 1
}

resource "aws_iam_role_policy" "login_lambda_logs" {
  name = "write-function-logs"
  role = aws_iam_role.login_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.login_lambda.arn}:log-stream:*"
    }]
  })
}

resource "aws_lambda_function" "login" {
  function_name    = local.login_lambda_name
  role             = aws_iam_role.login_lambda.arn
  filename         = data.archive_file.login_lambda.output_path
  source_code_hash = data.archive_file.login_lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 3

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.login_lambda.name
  }

  depends_on = [aws_iam_role_policy.login_lambda_logs]
}
