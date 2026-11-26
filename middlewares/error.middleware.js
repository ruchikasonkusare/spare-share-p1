const errorMiddleware = (err, req, res, next) => {
  console.error("ERROR:", {
    message: err.message,
    code: err.code,
    statusCode: err.statusCode,
    method: req.method,
    path: req.originalUrl,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });

  let statusCode = err.statusCode || err.status || 500;
  let code = err.code || "INTERNAL_SERVER_ERROR";
  let message = err.message || "Something went wrong on the server.";

  // Malformed or oversized request bodies
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      code: "INVALID_JSON",
      message: "Request body is not valid JSON.",
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large.",
    });
  }

  // Mongoose validation error
  if (err.name === "ValidationError") {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    const errors = Object.values(err.errors).map((error) => ({ field: error.path, message: error.message}));
    return res.status(statusCode).json({
      success: false,
      code,
      message: "Validation failed.",
      errors,
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    statusCode = 409;
    code = "DUPLICATE_RESOURCE";
    const fields = Object.keys(err.keyPattern || {});
    return res.status(statusCode).json({
      success: false,
      code,
      message: `Duplicate value for: ${fields.join(", ")}.`,
    });
  }

  // Mongoose invalid objectId / cast error
  if (err.name === "CastError") {
    statusCode = 400;
    code = "INVALID_ID";
    message = `Invalid ${err.path}.`;
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    code = "INVALID_TOKEN";
    message = "Invalid authentication token.";
  }

  if (err.name === "TokenExpiredError") {
    statusCode = 401;
    code = "TOKEN_EXPIRED";
    message = "Authentication token has expired.";
  }

  if (typeof code !== "string") {
    code = "INTERNAL_SERVER_ERROR";
  }

  // Never expose internal server details in production
  if (statusCode >= 500 && process.env.NODE_ENV === "production") {
    statusCode = 500;
    code = "INTERNAL_SERVER_ERROR";
    message = "Something went wrong on the server.";
  }

  return res.status(statusCode).json({
    success: false,
    code,
    message,
  });
};

module.exports = errorMiddleware;
