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

export function mapError(error: unknown) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        success: false,
        data: null,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      success: false,
      data: null,
      error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
    },
  };
}
