import { decrypt, encrypt } from '../lib/encrypt';

export const FORENSICS_LICENSE_KEY_PURPOSE = 'forensics-license-key' as const;

export function encryptForensicsLicenseKey(licenseKey: string, secret: string): Promise<string> {
  return encrypt(licenseKey, secret, FORENSICS_LICENSE_KEY_PURPOSE);
}

export function decryptForensicsLicenseKey(
  encryptedLicenseKey: string,
  secret: string
): Promise<string> {
  return decrypt(encryptedLicenseKey, secret, FORENSICS_LICENSE_KEY_PURPOSE);
}
