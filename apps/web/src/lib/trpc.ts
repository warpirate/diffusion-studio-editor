/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { supabase } from "./supabase";
import { showUpgradeDialog } from "@/components/upgrade-dialog";

import type { AppRouter } from "@diffusionstudio/api-contract";

/**
 * What every credit-backed call says when there is no Diffusion Studio
 * account behind it. Generated images, video, voice and transcription are
 * billed to one; the agent and the editor are not, and work without. The
 * wording is read by people in a toast and by agents in a tool result, so
 * it says what is missing and where to fix it.
 */
export const ACCOUNT_REQUIRED =
  "No Diffusion Studio account is connected. Generated images, video, voice and transcription need one — connect it under Settings › Account.";

/** Whether a call that bills credits can be made at all. */
export async function hasDiffusionAccount(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

/**
 * Fails credit-backed calls before they leave, with a reason. Without it a
 * build with no backend configured, or a user who never signed in, gets an
 * opaque network or 401 error from every generation.
 */
const accountRequiredLink: TRPCLink<AppRouter> = () => ({ next, op }) =>
  observable((observer) => {
    let inner: { unsubscribe(): void } | null = null;
    let cancelled = false;
    void hasDiffusionAccount().then((ok) => {
      if (cancelled) return;
      if (!ok) {
        observer.error(new TRPCClientError(ACCOUNT_REQUIRED));
        return;
      }
      inner = next(op).subscribe({
        next: (value) => observer.next(value),
        error: (err) => observer.error(err),
        complete: () => observer.complete(),
      });
    });
    return () => {
      cancelled = true;
      inner?.unsubscribe();
    };
  });

const paymentRequiredLink: TRPCLink<AppRouter> = () => ({ next, op }) =>
  observable((observer) => {
    const sub = next(op).subscribe({
      next: (value) => observer.next(value),
      error: (err) => {
        if (err instanceof TRPCClientError && err.data?.code === "PAYMENT_REQUIRED") {
          showUpgradeDialog();
        }
        observer.error(err);
      },
      complete: () => observer.complete(),
    });
    return () => sub.unsubscribe();
  });

export const trpc = createTRPCClient<AppRouter>({
  links: [
    accountRequiredLink,
    paymentRequiredLink,
    httpBatchLink({
      url: `${import.meta.env.VITE_API_URL ?? ""}/api/trpc`,
      async headers() {
        const session = await supabase?.auth.getSession();
        const token = session?.data.session?.access_token;
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
