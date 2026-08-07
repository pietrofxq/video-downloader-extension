// Sets `err.name` from the constructor so catch sites that map errors
// by name (popup error label, log filter) don't need a hand-maintained
// string per subclass.
class NamedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class TokenExpiredError extends NamedError {}
/**
 * A 403 on a URL that has NOT expired — the server is refusing a
 * still-valid credential. YouTube's poToken gate is the motivating
 * case: the URL is minutes old with hours left on its `expire`, and
 * reloading the page mints another URL that is refused identically.
 * Distinct from TokenExpiredError so the popup stops telling users to
 * reload for a failure a reload cannot fix.
 */
export class PlaybackGatedError extends NamedError {}
export class ManifestParseError extends NamedError {}
export class DecryptionError extends NamedError {}
export class RemuxError extends NamedError {}
export class DRMProtectedError extends NamedError {}
export class UnsupportedFormatError extends NamedError {}
/**
 * Not enough browser storage to stage the download. The adaptive path
 * writes both input streams to OPFS and then the combined output, so a
 * long 4K video can need well over twice its final size in free quota.
 * Raised up-front from the declared content lengths, because the
 * failure it replaces — running out mid-write, gigabytes in — is slow
 * and looks like a hang.
 */
export class InsufficientStorageError extends NamedError {}
