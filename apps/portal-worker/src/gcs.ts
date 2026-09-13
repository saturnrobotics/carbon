import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";

export type ImmutableObjectReference = {
  bucket: string;
  objectKey: string;
  generation: string;
  sha256: string;
  maxBytes?: number;
};

export async function captureExistingObject(
  bucket: string,
  objectKey: string,
  maximum: number,
  storage = new Storage()
): Promise<ImmutableObjectReference> {
  const file = storage.bucket(bucket).file(objectKey);
  const [metadata] = await file.getMetadata();
  const generation = String(metadata.generation ?? "");
  const size = Number(metadata.size ?? 0);
  if (!generation || !Number.isSafeInteger(size) || size < 1 || size > maximum)
    throw new Error("parser output exceeds its byte limit");
  const [bytes] = await storage
    .bucket(bucket)
    .file(objectKey, { generation })
    .download();
  if (bytes.length !== size)
    throw new Error("parser output changed during capture");
  return {
    bucket,
    objectKey,
    generation,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    maxBytes: maximum
  };
}

export async function captureImmutableUpload(
  input: {
    bucket: string;
    objectKey: string;
    bytes: Buffer;
    mimeType: string;
    maxBytes?: number;
  },
  storage = new Storage()
): Promise<ImmutableObjectReference & { mimeType: string; bytes: number }> {
  const maximum = input.maxBytes ?? 50_000_000;
  if (!input.bytes.length || input.bytes.length > maximum)
    throw new Error("intake object exceeds the parser byte limit");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const file = storage.bucket(input.bucket).file(input.objectKey);
  try {
    await file.save(input.bytes, {
      contentType: input.mimeType,
      resumable: false,
      validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: "private, no-store" }
    });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      (error as { code?: number }).code !== 412
    )
      throw error;
  }
  const [metadata] = await file.getMetadata();
  const generation = String(metadata.generation ?? "");
  const size = Number(metadata.size ?? 0);
  if (!generation || size !== input.bytes.length)
    throw new Error("object storage did not return the captured generation");
  const [stored] = await storage
    .bucket(input.bucket)
    .file(input.objectKey, { generation })
    .download();
  if (createHash("sha256").update(stored).digest("hex") !== sha256)
    throw new Error("content-addressed object key contains different bytes");
  return {
    bucket: input.bucket,
    objectKey: input.objectKey,
    generation,
    sha256,
    mimeType: input.mimeType,
    bytes: size,
    maxBytes: maximum
  };
}

/** Reads the exact object generation captured at intake, never the mutable latest object. */
export async function readImmutableObject(
  reference: ImmutableObjectReference,
  storage = new Storage()
): Promise<Buffer> {
  const file = storage
    .bucket(reference.bucket)
    .file(reference.objectKey, { generation: reference.generation });
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > (reference.maxBytes ?? 50_000_000)
  )
    throw new Error("intake object exceeds the parser byte limit");
  const [bytes] = await file.download();
  if (bytes.length !== size)
    throw new Error("intake object changed during immutable fetch");
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
    throw new Error("intake object hash does not match its captured identity");
  return bytes;
}
