terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  backend "s3" {
    bucket  = "noamshe-terraform-state-240742387601"
    key     = "agentic-sdlc/terraform.tfstate"
    region  = "eu-west-1"
    encrypt = true
  }

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }

    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
