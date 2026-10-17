output "api_url" {
  description = "Invoke URL for POST /thumbnails."
  value       = "https://${aws_api_gateway_rest_api.thumbnail_api.id}.execute-api.${var.region}.amazonaws.com/${aws_api_gateway_stage.this.stage_name}/thumbnails"
}

output "api_key_value" {
  description = "API key value."
  value       = aws_api_gateway_api_key.this.value
  sensitive   = true
}

output "bucket_name" {
  description = "S3 bucket name."
  value       = aws_s3_bucket.images.bucket
}
