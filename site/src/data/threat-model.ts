// STRIDE view of the career: every mitigation must trace to a line in resume.ts.

export interface Mitigation {
  control: string;
  evidence: string;
}

export interface Threat {
  id: 'S' | 'T' | 'R' | 'I' | 'D' | 'E';
  name: string;
  property: string;
  question: string;
  mitigations: Mitigation[];
}

export const stride: Threat[] = [
  {
    id: 'S',
    name: 'Spoofing',
    property: 'Authentication',
    question: 'Can someone pretend to be a user, workload or admin?',
    mitigations: [
      { control: 'Federated cloud identity', evidence: 'IAM Role federation with Okta across USAA’s multi-cloud estate.' },
      { control: 'Identity consolidation', evidence: 'Centrify AD Bridging on 10,000+ Unix/Linux systems: ~35,000 local identities reduced to ~2,000.' },
      { control: 'Strong authentication for privilege', evidence: 'MFA for privileged accounts via PowerBroker; hardware MFA enrolled for AWS root users.' },
      { control: 'Rogue identity cleanup', evidence: 'Triaged Google Cloud Identity: unmanaged identities, unapproved OIDC clients, non-USAA identities.' },
    ],
  },
  {
    id: 'T',
    name: 'Tampering',
    property: 'Integrity',
    question: 'Can someone change code, config or data they should not?',
    mitigations: [
      { control: 'Preventative guardrails', evidence: 'Service Control Policies (e.g. restrict IGW) across AWS Organizations.' },
      { control: 'Hardened baselines and drift detection', evidence: 'CIS baselines with Qualys Policy Compliance to reduce configuration/patching drift.' },
      { control: 'Mandatory access control', evidence: 'SELinux adoption for OpenShift and the 20,000+ server fleet.' },
      { control: 'Pipeline security', evidence: 'TwistLock vulnerability and configuration management in GitLabCI.' },
      { control: 'Malicious content inspection', evidence: 'S3 malware scanning of 30M+ objects per day.' },
    ],
  },
  {
    id: 'R',
    name: 'Repudiation',
    property: 'Non-repudiation',
    question: 'Could someone act and later deny it?',
    mitigations: [
      { control: 'Centralized audit trail', evidence: 'Centralized CloudTrail logs to S3, consumed by the on-premises SIEM.' },
      { control: 'Network evidence', evidence: 'Enforced VPC flow logs feeding GuardDuty.' },
      { control: 'Recorded privileged sessions', evidence: 'BeyondTrust PasswordSafe privileged session management.' },
      { control: 'Asset ownership', evidence: 'Public Cloud Account Metadata app used by 3,000+ developers to track who owns what.' },
    ],
  },
  {
    id: 'I',
    name: 'Information disclosure',
    property: 'Confidentiality',
    question: 'Can data leave where it is allowed to be?',
    mitigations: [
      { control: 'Data perimeter', evidence: 'VPC Endpoint Policy Orchestration, presented at AWS re:Inforce 2023.' },
      { control: 'Encryption by sensitivity', evidence: 'Client/server-side encryption with AWS managed or customer managed keys.' },
      { control: 'Exposure removal', evidence: 'Monitored and removed public S3 buckets and Security Groups open to 0.0.0.0/0.' },
      { control: 'Misconfiguration hunting', evidence: 'Tiger team remediation across 70+ GCP projects, 45+ AWS accounts, 50+ Azure subscriptions.' },
    ],
  },
  {
    id: 'D',
    name: 'Denial of service',
    property: 'Availability',
    question: 'Can the business keep running when something breaks?',
    mitigations: [
      { control: 'Resilience posture', evidence: 'AWS Resilience Hub across the AWS Organization with automated onboarding and reporting.' },
      { control: 'Resilience automation', evidence: 'Led the AWS Resilience Automation capability within Public Cloud Security.' },
      { control: 'Continuous monitoring', evidence: 'Prisma Public Cloud with automated enrollment of every AWS, GCP and Azure account.' },
    ],
  },
  {
    id: 'E',
    name: 'Elevation of privilege',
    property: 'Authorization',
    question: 'Can someone gain more access than they were given?',
    mitigations: [
      { control: 'Least privilege at scale', evidence: 'IAM access patterns for 450+ AWS accounts, 220+ GCP projects and 2 Azure tenants.' },
      { control: 'Kill long-lived credentials', evidence: 'Converted IAM Users to Roles.' },
      { control: 'Key lifecycle management', evidence: 'Inventoried 150,000+ SSH key pairs and removed 40,000+ unused authorizations.' },
      { control: 'Privilege delegation', evidence: 'PasswordSafe for delegated elevated privileges across cloud apps and servers.' },
    ],
  },
];
