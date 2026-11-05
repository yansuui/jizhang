export class IdentityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export function invalidInvitation(): IdentityError {
  return new IdentityError(
    400,
    'INVALID_INVITATION',
    'Invitation is invalid, expired, revoked or already used.',
  );
}
