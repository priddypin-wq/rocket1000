export class ApiError extends Error {
  constructor(status, message, code = "REQUEST_REJECTED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
