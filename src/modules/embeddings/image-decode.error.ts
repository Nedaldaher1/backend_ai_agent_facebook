/**
 * Thrown when raw image bytes cannot be decoded into an image (e.g. a corrupt
 * PNG that libspng/sharp rejects, or an unreadable/unsupported byte stream).
 *
 * This is a CLIENT problem (bad input), not a server fault — the HTTP layer
 * translates it to 422 Unprocessable Entity. It deliberately wraps ONLY the
 * byte-sniff/decode step (thrown by `downloadImage` in the vision pipeline);
 * failures of the remote embedding call stay generic Errors so they surface as
 * 500 and pollute monitoring as the real server faults they are. The original
 * cause is preserved via `cause`.
 */
export class ImageDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImageDecodeError';
  }
}
