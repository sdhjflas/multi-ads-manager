import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../validation.js';

export interface EncryptedSecret {
  version: 1;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function parseKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32)
    throw new AppError('ORBIT_VAULT_KEY must decode to exactly 32 bytes.', 503);
  return key;
}

export class CredentialVault {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(key: string) {
    this.key = parseKey(key);
    this.keyId = createHash('sha256').update(this.key).digest('hex').slice(0, 12);
  }

  encrypt(value: unknown, context: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      version: 1,
      keyId: this.keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt<T>(payload: EncryptedSecret, context: string): T {
    if (payload.version !== 1 || payload.keyId !== this.keyId)
      throw new AppError('The credential vault key does not match this encrypted secret.', 503);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(payload.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(clear) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('The encrypted credential could not be authenticated.', 503);
    }
  }
}

export function vaultFromEnv(): CredentialVault | null {
  const key = process.env.ORBIT_VAULT_KEY?.trim();
  return key ? new CredentialVault(key) : null;
}
