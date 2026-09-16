/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Signing in to a Diffusion Studio account. This used to be the door into
// the app; it is now one card, because the account buys generated images,
// video, voice and transcription rather than the editor itself. It shows
// up on the sign-in page and in Settings, which is where someone who
// skipped it at the start goes looking.

import { Show, createSignal, type JSX } from 'solid-js';
import { toast } from 'somoto';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TextField, TextFieldInput, TextFieldLabel } from '@/components/ui/text-field';
import { DevAuthCodeInput } from '@/components/dev-auth-code-input';
import { useAuth } from '@/context/auth';
import { supabase } from '@/lib/supabase';

type OAuthButtonProps = {
  icon: string;
  label: string;
  onClick: () => void;
};

function OAuthButton(props: OAuthButtonProps) {
  return (
    <Button
      variant="secondary"
      class="w-full gap-0 px-0.5"
      onClick={props.onClick}
    >
      <Icon name={props.icon} class="size-6" />
      <span class="min-w-0 flex-1 text-center">{props.label}</span>
      <span class="size-6 shrink-0" aria-hidden="true" />
    </Button>
  );
}

export type AccountSignInCardProps = {
  title?: string;
  description?: string;
  /** Rendered under the form: the legal line on the sign-in page, nothing in Settings. */
  footer?: JSX.Element;
};

/**
 * The card itself. Renders nothing when the build has no backend
 * configured — there would be no account to sign in to.
 */
export function AccountSignInCard(props: AccountSignInCardProps) {
  const auth = useAuth();
  const [email, setEmail] = createSignal('');
  const [otpSending, setOtpSending] = createSignal(false);

  const handleOtpSubmit = async (e: SubmitEvent) => {
    e.preventDefault();

    const value = email().trim();
    if (!value) return;

    setOtpSending(true);
    const { error } = await auth.signInWithOtp(value);
    setOtpSending(false);

    if (error) {
      toast.error(error);
    } else {
      toast.success('Check your email for the login link');
    }
  };

  return (
    <Show when={!!supabase}>
      <div class="flex flex-col gap-3 rounded-xl bg-accent/40 p-4">
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="text-[12px] font-450 text-foreground">
              {props.title ?? 'Sign in or sign up'}
            </h2>
            <p class="text-xs text-muted-foreground">
              {props.description ?? 'Choose your preferred method'}
            </p>
          </div>

          <div class="flex flex-col gap-3">
            <OAuthButton
              icon="social.google"
              label="Continue with Google"
              onClick={() => auth.signInWithOAuth('google')}
            />
            <OAuthButton
              icon="social.github"
              label="Continue with GitHub"
              onClick={() => auth.signInWithOAuth('github')}
            />
          </div>

          <div class="flex items-center justify-center gap-3">
            <div class="h-px flex-1 bg-border" />
            <span class="text-xs text-muted-foreground">or</span>
            <div class="h-px flex-1 bg-border" />
          </div>
        </div>

        <form class="flex flex-col gap-3" onSubmit={handleOtpSubmit}>
          <TextField>
            <TextFieldLabel
              uiSize="compact"
              class="text-xs text-muted-foreground"
            >
              Email
            </TextFieldLabel>
            <TextFieldInput
              uiSize="compact"
              type="email"
              placeholder="Enter your email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            />
          </TextField>

          <Button
            type="submit"
            class="w-full"
            disabled={otpSending() || !email().trim()}
          >
            {otpSending() ? 'Sending...' : 'Send magic link'}
          </Button>
        </form>

        <DevAuthCodeInput />

        {props.footer}
      </div>
    </Show>
  );
}

/** The privacy / terms line the full-page sign-in shows. */
export function AccountSignInLegal() {
  return (
    <span class="px-1 text-center text-xs text-muted-foreground">
      By continuing, you agree to our{' '}
      <a
        href="https://www.diffusion.studio/legal/privacy-policy"
        target="_blank"
        rel="noopener noreferrer"
        class="underline hover:text-foreground"
      >
        Privacy Policy
      </a>{' '}
      and{' '}
      <a
        href="https://www.diffusion.studio/legal/terms-of-service"
        target="_blank"
        rel="noopener noreferrer"
        class="underline hover:text-foreground"
      >
        Terms of Service
      </a>
      .
    </span>
  );
}
