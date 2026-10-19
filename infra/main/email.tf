# Outbound-only mail for the contact form: noreply@<domain>, DKIM-signed by SES,
# custom MAIL FROM so SPF aligns, and DMARC telling receivers to quarantine spoofs.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "dkim" {
  count = 3 # Easy DKIM always issues three tokens.

  zone_id = data.aws_route53_zone.site.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = local.mail_from
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = local.mail_from
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

# The apex itself never sends mail directly.
resource "aws_route53_record" "apex_spf" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 -all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=quarantine; adkim=s; aspf=r; pct=100"]
}

# While the account is in the SES sandbox, recipients must be verified too.
# Terraform creating this sends a one-time verification link to the inbox.
resource "aws_sesv2_email_identity" "recipient" {
  email_identity = var.contact_to_email
}
