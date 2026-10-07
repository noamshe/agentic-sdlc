resource "aws_apigatewayv2_api" "lab" {
  name          = "${local.lambda_name}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lab_lambda" {
  api_id                 = aws_apigatewayv2_api.lab.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.lab.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# GET /hello -> lab_lambda integration -> aws_lambda_function.lab (hello).
resource "aws_apigatewayv2_route" "hello" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "GET /hello"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.lab_lambda.id}"
}

resource "aws_apigatewayv2_stage" "lab" {
  api_id      = aws_apigatewayv2_api.lab.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "lab_api" {
  statement_id  = "AllowHelloHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lab.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lab.execution_arn}/${aws_apigatewayv2_stage.lab.name}/GET/hello"
}

output "hello_url" {
  description = "Public GET endpoint for the lab Lambda."
  value       = "${aws_apigatewayv2_api.lab.api_endpoint}/hello"
}

resource "aws_apigatewayv2_integration" "login_lambda" {
  api_id                 = aws_apigatewayv2_api.lab.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.login.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# GET /login -> login_lambda integration -> aws_lambda_function.login.
resource "aws_apigatewayv2_route" "login" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "GET /login"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.login_lambda.id}"
}

resource "aws_lambda_permission" "login_api" {
  statement_id  = "AllowLoginHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.login.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lab.execution_arn}/${aws_apigatewayv2_stage.lab.name}/GET/login"
}

output "login_url" {
  description = "Public login page endpoint."
  value       = "${aws_apigatewayv2_api.lab.api_endpoint}/login"
}

# Demo back office uses the existing login Lambda package and integration.
resource "aws_apigatewayv2_route" "back_office" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "GET /back-office"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.login_lambda.id}"
}

resource "aws_lambda_permission" "back_office_api" {
  statement_id  = "AllowBackOfficeHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.login.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lab.execution_arn}/${aws_apigatewayv2_stage.lab.name}/GET/back-office"
}

# Workflow guide is packaged alongside the other demo pages.
resource "aws_apigatewayv2_route" "agentic_flow" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "GET /agentic-flow"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.login_lambda.id}"
}

resource "aws_lambda_permission" "agentic_flow_api" {
  statement_id  = "AllowAgenticFlowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.login.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lab.execution_arn}/${aws_apigatewayv2_stage.lab.name}/GET/agentic-flow"
}
