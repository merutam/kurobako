// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

export type DomainErrorCode =
  | "write_denied"
  | "view_changed"
  | "too_many_views"
  | "invalid_view"
  | "invalid_envelope"
  | "view_envelopes_required"
  | "storage_full";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly status: 400 | 403 | 409 | 507,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Custom Error properties do not survive RPC; transmit a plain discriminated value. */
export type DomainFailure = {
  __kurobakoError: { code: DomainErrorCode; status: DomainError["status"]; message: string };
};
export const domainFailure = (error: DomainError): DomainFailure => ({
  __kurobakoError: { code: error.code, status: error.status, message: error.message },
});
export const unwrapDomainFailure = <T>(value: T): T => {
  if (value && typeof value === "object" && "__kurobakoError" in value) {
    const error = (value as DomainFailure).__kurobakoError;
    throw new DomainError(error.code, error.status, error.message);
  }
  return value;
};
