/**
 * Backups of the assessments stored on this device.
 *
 * A backup is the plain export encrypted with a passphrase (AES-256-GCM, key from
 * PBKDF2-SHA-256), so a lost file exposes neither results nor eye images. Everything runs
 * in the browser with WebCrypto; nothing here touches the network.
 */
import type { EyeSide, OutputLevel, StoredAssessment } from "../types";

export const EXPORT_FORMAT = "eyeref-assessments/1";
export const BACKUP_FORMAT = "eyeref-backup/1";
/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

export interface PlainExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  items: StoredAssessment[];
}

export interface EncryptedBackup {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  count: number;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
}

/** A backup that cannot be read: wrong passphrase, damaged file, or not an EyeRef file. */
export class BackupError extends Error {}

const LEVELS: OutputLevel[] = ["quantitative", "screening", "repeat"];
const EYES: EyeSide[] = ["OD", "OS"];
const enc = new TextEncoder();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Eye images stay out of plain exports; only an encrypted backup carries them. */
export function withoutImages(items: StoredAssessment[]): StoredAssessment[] {
  return items.map((a) => ({
    ...a,
    frames: a.frames.map((f) => {
      const copy = { ...f };
      delete copy.cropDataUrl;
      return copy;
    }),
  }));
}

export const countImages = (items: StoredAssessment[]) =>
  items.reduce((n, a) => n + a.frames.filter((f) => !!f.cropDataUrl).length, 0);

export function plainExport(items: StoredAssessment[], exportedAt = new Date()): PlainExport {
  return { format: EXPORT_FORMAT, exportedAt: exportedAt.toISOString(), items };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  // WebCrypto exists only in secure contexts: HTTPS, or localhost during development.
  if (!globalThis.crypto?.subtle)
    throw new BackupError("Encrypted backups need the app to be opened over HTTPS.");
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts the assessments with the passphrase. `iterations` is lowered only in tests. */
export async function encryptBackup(
  items: StoredAssessment[],
  passphrase: string,
  { iterations = PBKDF2_ITERATIONS, now = new Date() } = {},
): Promise<EncryptedBackup> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH)
    throw new BackupError(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const plain = enc.encode(JSON.stringify(plainExport(items, now)));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(BACKUP_FORMAT) },
    key,
    plain,
  );
  return {
    format: BACKUP_FORMAT,
    createdAt: now.toISOString(),
    count: items.length,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(new Uint8Array(data)),
  };
}

/** What a chosen file is, before any passphrase is asked for. */
export type BackupFile =
  { kind: "encrypted"; backup: EncryptedBackup } | { kind: "plain"; export: PlainExport };

export function readBackupFile(text: string): BackupFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackupError("This is not an EyeRef backup or export file.");
  }
  const f = isObj(json) ? json : {};
  if (f.format === BACKUP_FORMAT) {
    const { kdf, cipher } = f;
    const ok =
      isObj(kdf) &&
      kdf.name === "PBKDF2" &&
      kdf.hash === "SHA-256" &&
      typeof kdf.iterations === "number" &&
      Number.isInteger(kdf.iterations) &&
      kdf.iterations >= 100_000 &&
      kdf.iterations <= 10_000_000 &&
      typeof kdf.salt === "string" &&
      isObj(cipher) &&
      cipher.name === "AES-GCM" &&
      typeof cipher.iv === "string" &&
      typeof f.data === "string";
    if (!ok) throw new BackupError("This backup file is damaged.");
    return { kind: "encrypted", backup: f as unknown as EncryptedBackup };
  }
  if (f.format === EXPORT_FORMAT && Array.isArray(f.items))
    return { kind: "plain", export: f as unknown as PlainExport };
  throw new BackupError("This is not an EyeRef backup or export file.");
}

export async function decryptBackup(backup: EncryptedBackup, passphrase: string): Promise<PlainExport> {
  let plain: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, fromBase64(backup.kdf.salt), backup.kdf.iterations);
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(backup.cipher.iv), additionalData: enc.encode(BACKUP_FORMAT) },
      key,
      fromBase64(backup.data),
    );
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError("Wrong passphrase, or the file is damaged.");
  }
  const inner = readBackupFile(new TextDecoder().decode(plain));
  if (inner.kind !== "plain") throw new BackupError("This backup file is damaged.");
  return inner.export;
}

/**
 * Whether a restored item is a well-formed assessment. Simulated and real data must stay
 * apart: the report's SIMULATED flag has to agree with every frame it was computed from.
 */
export function isValidAssessment(a: unknown): a is StoredAssessment {
  if (!isObj(a) || typeof a.id !== "string" || !a.id || a.id.length > 100) return false;
  if (typeof a.createdAt !== "string" || Number.isNaN(Date.parse(a.createdAt))) return false;
  if (!isObj(a.profile) || typeof a.profile.label !== "string" || typeof a.profile.ageGroup !== "string")
    return false;
  const r = a.report;
  if (!isObj(r) || typeof r.simulated !== "boolean" || !isObj(r.eyes)) return false;
  const eyes = r.eyes;
  const eyesOk = EYES.every((e) => {
    const eye = eyes[e];
    return isObj(eye) && LEVELS.includes(eye.outputLevel as OutputLevel);
  });
  if (!eyesOk) return false;
  if (!Array.isArray(a.frames) || !Array.isArray(a.visionTests)) return false;
  const framesAgree = a.frames.every(
    (f) => isObj(f) && isObj(f.metadata) && f.metadata.simulated === r.simulated,
  );
  if (!framesAgree) return false;
  return r.simulated || a.simTruth === undefined;
}

export interface RestorePlan {
  /** Valid assessments not yet on this device. */
  add: StoredAssessment[];
  /** Valid assessments whose id is already stored here; they are left untouched. */
  duplicates: number;
  /** Items that failed validation. */
  rejected: number;
}

export function planRestore(exported: PlainExport, existingIds: Iterable<string>): RestorePlan {
  const have = new Set(existingIds);
  const plan: RestorePlan = { add: [], duplicates: 0, rejected: 0 };
  for (const item of exported.items) {
    if (!isValidAssessment(item)) plan.rejected++;
    else if (have.has(item.id)) plan.duplicates++;
    else {
      plan.add.push(item);
      have.add(item.id);
    }
  }
  return plan;
}
