import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 지자체 사이트 계정 비밀번호용 AES-256-GCM 암호화.
 * 키는 CREDENTIALS_ENC_KEY(64자 hex = 32바이트) 환경변수로 주입.
 * 평문은 DB에 절대 저장하지 않으며, 복호화는 worker에서 제출 직전에만 수행한다.
 */

const ALG = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncryptedValue {
  /** base64(iv) */
  iv: string;
  /** base64(ciphertext + authTag) */
  data: string;
}

export function loadEncKey(env: string | undefined = process.env.CREDENTIALS_ENC_KEY): Buffer {
  if (!env || !/^[0-9a-fA-F]{64}$/.test(env)) {
    throw new Error("CREDENTIALS_ENC_KEY must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(env, "hex");
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: Buffer.concat([enc, tag]).toString("base64"),
  };
}

export function decryptSecret(value: EncryptedValue, key: Buffer): string {
  const iv = Buffer.from(value.iv, "base64");
  const buf = Buffer.from(value.data, "base64");
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
