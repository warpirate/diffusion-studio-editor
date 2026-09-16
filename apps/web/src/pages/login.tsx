/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The full-page Diffusion Studio sign-in. No longer the way into the app —
// `ModelLoginPage` is, and it asks for the agent instead — but still the
// page a callback or a deep link can land on, and the one a build that
// wants an account up front would gate with.

import { Show } from 'solid-js';

import { AccountSignInCard, AccountSignInLegal } from '@/components/account-sign-in';
import { Icon } from '@/components/ui/icon';
import { useFullscreenState } from '@/hooks/use-fullscreen-state';

export function LoginPage() {
  const isFullscreen = useFullscreenState();

  return (
    <div class="flex flex-col bg-background fixed inset-0 z-999">
      <Show when={!!window.desktop && !isFullscreen()}>
        <div class="absolute inset-x-0 top-0 h-10 z-20" style="-webkit-app-region: drag;" />
      </Show>
      <Show when={!window.desktop}>
        <div class="flex items-center gap-1 p-4">
          <Icon name="diffusion-logo" class="size-6" />
          <span class="text-sm font-450 text-foreground">Diffusion Studio</span>
        </div>
      </Show>

      <div class="flex flex-1 items-center justify-center pb-16">
        <div class="flex w-70 flex-col gap-3">
          <AccountSignInCard footer={<AccountSignInLegal />} />
        </div>
      </div>
    </div>
  );
}
