export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const unauthorized = (msg = 'Sign in to continue') => new HttpError(401, msg);
export const forbidden = (msg, extra) => new HttpError(403, msg, extra);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);
export const paymentRequired = (msg, extra) => new HttpError(402, msg, extra);
