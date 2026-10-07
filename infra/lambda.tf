locals {
  lambda_name = "agentic-sdlc-lab-hello"
}

data "archive_file" "lab_lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.mjs"
  output_path = "${path.module}/lambda/function.zip"
}

resource "aws_iam_role" "lab_lambda" {
  name = "${local.lambda_name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "lab_lambda" {
  name              = "/aws/lambda/${local.lambda_name}"
  retention_in_days = 1
}

resource "aws_iam_role_policy" "lab_lambda_logs" {
  name = "write-function-logs"
  role = aws_iam_role.lab_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.lab_lambda.arn}:log-stream:*"
    }]
  })
}

resource "aws_lambda_function" "lab" {
  function_name    = local.lambda_name
  role             = aws_iam_role.lab_lambda.arn
  filename         = data.archive_file.lab_lambda.output_path
  source_code_hash = data.archive_file.lab_lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 10

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lab_lambda.name
  }

  depends_on = [aws_iam_role_policy.lab_lambda_logs, aws_iam_role_policy.lab_lambda_invoke_inner]
}

resource "aws_iam_role_policy" "lab_lambda_invoke_inner" {
  name = "invoke-new-inner-lambda-test"
  role = aws_iam_role.lab_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.inner.arn
    }]
  })
}
