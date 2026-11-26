// Consistent application error factory used by every service and controller.
const createError = (message, statusCode = 500, code = "INTERNAL_SERVER_ERROR", details) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

module.exports = { createError };
