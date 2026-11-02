export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }

  static badRequest(message: string, fields?: Record<string, string>) {
    return new ApiError(400, 'bad_request', message, fields);
  }
  static validation(fields: Record<string, string>) {
    return new ApiError(422, 'validation_failed', 'Some fields are invalid', fields);
  }
  static unauthorized(code = 'unauthorized', message = 'Authentication required') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'Not allowed') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(what = 'Resource') {
    return new ApiError(404, 'not_found', `${what} not found`);
  }
  static conflict(message: string) {
    return new ApiError(409, 'conflict', message);
  }
}
