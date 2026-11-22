// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Web Push over the network, the same on Bun and Workers: the domain builds
// the request (domain/push.ts), this sends it.
import {
  type PushConfig,
  type PushMessage,
  type PushResult,
  type PushTarget,
  pushRequest,
  pushResultOf,
} from "../domain/push";

/** A stalled push service must not hold background work open indefinitely. */
const PUSH_TIMEOUT_MS = 10_000;

export const pushSender =
  (config: PushConfig | null) =>
  async (target: PushTarget, message: PushMessage): Promise<PushResult> => {
    if (!config) return "failed";
    const { url, init } = await pushRequest(target, message, config);
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    await response.body?.cancel();
    return pushResultOf(response.status);
  };
