variable "project" {
  description = "Project name used for resource naming."
  type        = string
  default     = "thumbnailer"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"
}

variable "stage_name" {
  description = "API Gateway stage name."
  type        = string
  default     = "v1"
}

variable "retention_days" {
  description = "Number of days to retain objects in S3."
  type        = number
  default     = 7
}

variable "thumb_size" {
  description = "Thumbnail size in pixels."
  type        = number
  default     = 256
}
