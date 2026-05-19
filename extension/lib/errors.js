class NamedError extends Error {
  constructor(message, options) {
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
