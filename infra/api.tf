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
