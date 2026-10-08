import type { DomainSuffix } from "./config";

export interface SessionUser {
  login: string;
  verifiedAt: string;
  keyId: number | null;
  keyType: string | null;
  /** GitHub avatar URL, from the GitHub API. */
  avatarUrl: string | null;
  canRegisterContrib: boolean;
}

export interface DomainRecord {
  fqdn: string;
  label: string;
  suffix: DomainSuffix;
  zone: string;
  zoneId: string;
  owner: string;
  nameservers: string[];
  /** Glue A/AAAA records created inside the zone for in-zone nameservers. */
  glue: GlueRecord[];
  recordIds: string[];
  createdAt: string;
}

export interface GlueRecord {
  host: string;
  addresses: string[];
  recordIds: string[];
}

/** A pending login, created by /api/auth/start and consumed by the callback. */
export interface PendingChallenge {
  challengeCode: string;
  createdAt: string;
  callbackUrl: string;
  redirectUrl: string;
  consumedAt?: string;
}

/** Result the verifier delivered to /api/auth/callback for a challenge code. */
export interface VerifiedLogin {
  challengeCode: string;
  login: string;
  keyId: number | null;
  keyType: string | null;
  totalKeys: number | null;
  verifiedAt: string;
  /** Hash of the payload the verifier signed, kept for audit. */
  payloadHash: string;
}

export interface NameserverInput {
  host: string;
  addresses?: string[];
}
