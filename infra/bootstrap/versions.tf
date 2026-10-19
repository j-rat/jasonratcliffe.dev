terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }

  # Step 1 runs with local state. After the state bucket exists, uncomment this
  # block and run `terraform init -migrate-state -backend-config=../backend.hcl`
  # (see docs/DEPLOYMENT.md, step 4) so bootstrap state also lives in S3.
  backend "s3" {
    key = "bootstrap/terraform.tfstate"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}
