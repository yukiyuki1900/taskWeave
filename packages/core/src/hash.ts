import { createHash } from 'node:crypto';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
