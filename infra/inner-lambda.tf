locals {
  inner_lambda_name = "new-inner-lambda-test"
}

data "archive_file" "inner_lambda" {
  type        = "zip"
  source_file = "${path.module}/inner-lambda/index.mjs"
  output_path = "${path.module}/inner-lambda/function.zip"
}

resource "aws_iam_role" "inner_lambda" {
  name = "${local.inner_lambda_name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "inner_lambda" {
  name              = "/aws/lambda/${local.inner_lambda_name}"
  retention_in_days = 1
}

resource "aws_iam_role_policy" "inner_lambda_logs" {
  name = "write-function-logs"
  role = aws_iam_role.inner_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.inner_lambda.arn}:log-stream:*"
    }]
  })
}

resource "aws_lambda_function" "inner" {
  function_name    = local.inner_lambda_name
  role             = aws_iam_role.inner_lambda.arn
  filename         = data.archive_file.inner_lambda.output_path
  source_code_hash = data.archive_file.inner_lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 3

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.inner_lambda.name
  }

  depends_on = [aws_iam_role_policy.inner_lambda_logs]
}
