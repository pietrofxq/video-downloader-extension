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
export class ManifestParseError extends NamedError {}
export class DecryptionError extends NamedError {}
export class RemuxError extends NamedError {}
export class DRMProtectedError extends NamedError {}
export class UnsupportedFormatError extends NamedError {}
