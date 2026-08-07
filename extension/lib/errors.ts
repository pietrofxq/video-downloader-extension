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
