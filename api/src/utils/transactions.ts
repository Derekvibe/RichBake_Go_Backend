import mongoose, { type ClientSession } from "mongoose";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown[],
  ) {
    super(message);
  }
}

export async function runTx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}

function errorBody(code: string, message: string, details?: unknown) {
  return {
    success: false,
    data: null,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export function mapError(error: unknown) {
  if (error instanceof ApiError) {
    return { status: error.status, body: errorBody(error.code, error.message, error.details) };
  }
  if (error instanceof mongoose.Error.CastError || (error instanceof Error && error.name === "BSONError")) {
    return { status: 400, body: errorBody("INVALID_ID", "One or more identifiers are invalid") };
  }
  if (error instanceof mongoose.Error.ValidationError) {
    return { status: 400, body: errorBody("VALIDATION_ERROR", error.message) };
  }
  if ((error as { code?: unknown })?.code === 11000) {
    return { status: 409, body: errorBody("DUPLICATE", "A record with these details already exists") };
  }
  if (error instanceof Error && error.name === "MulterError") {
    const tooLarge = (error as { code?: string }).code === "LIMIT_FILE_SIZE";
    return { status: tooLarge ? 413 : 400, body: errorBody("INVALID_UPLOAD", tooLarge ? "Image must be 2 MB or smaller" : "Invalid file upload") };
  }
  if ((error as { type?: unknown })?.type === "entity.too.large") {
    return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body is too large") };
  }
  if ((error as { type?: unknown })?.type === "entity.parse.failed") {
    return { status: 400, body: errorBody("INVALID_JSON", "Request body is not valid JSON") };
  }
  return { status: 500, body: errorBody("INTERNAL_ERROR", "Unexpected error") };
}
