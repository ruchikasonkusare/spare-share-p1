const mongoose = require("mongoose");
const { createError } = require("./errors");

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

const isObjectId = (value) =>
  value instanceof mongoose.Types.ObjectId ||
  (typeof value === "string" && OBJECT_ID_PATTERN.test(value));

const assertObjectId = (value, label = "identifier") => {
  if (!isObjectId(value)) {
    throw createError(`Invalid ${label}.`, 400, "INVALID_IDENTIFIER");
  }
  return String(value);
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Returns a trimmed string or throws. `required: false` allows undefined/null.
const readString = (value, label, { required = true, min = 1, max = 500, pattern } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw createError(`${label} is required.`, 400, "VALIDATION_ERROR");
    return undefined;
  }
  if (typeof value !== "string") {
    throw createError(`${label} must be a string.`, 400, "VALIDATION_ERROR");
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw createError(`${label} must be between ${min} and ${max} characters.`, 400, "VALIDATION_ERROR");
  }
  if (pattern && !pattern.test(trimmed)) {
    throw createError(`${label} has an invalid format.`, 400, "VALIDATION_ERROR");
  }
  return trimmed;
};

const readInt = (value, label, { required = true, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw createError(`${label} is required.`, 400, "VALIDATION_ERROR");
    return undefined;
  }
  const number = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw createError(`${label} must be an integer between ${min} and ${max}.`, 400, "VALIDATION_ERROR");
  }
  return number;
};

const readBoolean = (value, label, { required = true } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw createError(`${label} is required.`, 400, "VALIDATION_ERROR");
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw createError(`${label} must be a boolean.`, 400, "VALIDATION_ERROR");
  }
  return value;
};

const readEnum = (value, label, allowed, { required = true } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw createError(`${label} is required.`, 400, "VALIDATION_ERROR");
    return undefined;
  }
  if (!allowed.includes(value)) {
    throw createError(`${label} must be one of: ${allowed.join(", ")}.`, 400, "VALIDATION_ERROR");
  }
  return value;
};

module.exports = {
  isObjectId,
  assertObjectId,
  isPlainObject,
  readString,
  readInt,
  readBoolean,
  readEnum,
};
