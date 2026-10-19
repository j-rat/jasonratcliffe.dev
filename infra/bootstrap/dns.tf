# The hosted zone lives in bootstrap so its nameservers never change when the
# main stack is rebuilt. Paste the four nameservers into Squarespace once.
resource "aws_route53_zone" "site" {
  name    = var.domain_name
  comment = "Public zone for ${var.domain_name} (managed by Terraform)"

  lifecycle {
    prevent_destroy = true
  }
}
