/** Conservative parser input set. Signature validation complements the isolated
 * parser; originals are always downloaded as attachments with sniffing disabled. */
export const manualMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff"
]);
export function validateManualFile(mimeType: string, bytes: Buffer): void {
  const prefix = (signature: readonly number[]) =>
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);
  const valid =
    (mimeType === "application/pdf" &&
      bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (mimeType === "image/png" && prefix([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (mimeType === "image/jpeg" && prefix([255, 216, 255])) ||
    (mimeType === "image/tiff" &&
      (prefix([73, 73, 42, 0]) || prefix([77, 77, 0, 42])));
  if (!valid || bytes.length > 50_000_000)
    throw new Error("unsupported intake file");
}
