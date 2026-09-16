/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Router, HashRouter, Route, useLocation } from '@solidjs/router';
import { ColorModeProvider } from '@kobalte/core';
import { Show, createEffect, type JSX } from 'solid-js';
import { Toaster } from "@/components/ui/sonner";
import { AppContextMenu } from "@/components/app-context-menu";

import { AuthProvider, useAuth } from '@/context/auth';
import { agentStateResolved, ensureConnected, needsAgentLogin } from '@/agent-chat/store';
import { agentSetupOpen, closeAgentSetup } from '@/agent-chat/auth-store';
import { ModelLoginPage } from '@/pages/model-login';
import { PersistRoute } from '@/lib/persist-route';
import { EditorApi } from '@/dapi';
import { UpgradeDialog } from '@/components/upgrade-dialog';
import { PurchaseSuccess } from '@/components/purchase-success';
import { ScreenTooSmall } from '@/components/screen-too-small';
import { UnsupportedBrowser } from '@/components/unsupported-browser';
import { ProjectPage } from '@/pages/project';
import { AuthCallbackPage } from '@/pages/auth-callback';
import { NotFoundPage } from '@/pages/not-found';
import { DashboardPage } from '@/pages/dashboard';

/**
 * What has to be true before the editor is usable. The agent's sign-in is
 * the gate: it is what the editing is done with, and it is the one this
 * build can always offer. A Diffusion Studio account is separate — it pays
 * for generated images, video and voice — so it is only asked for where
 * this build is configured for one, and never before the editor opens.
 */
function AuthGate(props: { children: JSX.Element }) {
  const auth = useAuth();
  ensureConnected();

  return (
    <Show when={!auth.isLoading() && agentStateResolved()}>
      <Show when={!needsAgentLogin()} fallback={<ModelLoginPage />}>
        {props.children}
      </Show>
    </Show>
  );
}

function BootSplash() {
  const auth = useAuth();
  ensureConnected();

  createEffect(() => {
    if (auth.isLoading() || !agentStateResolved()) return;
    document.getElementById('boot-splash')?.remove();
  });

  return null;
}

function EnvironmentOverlays() {
  const location = useLocation();
  const onCheckoutPage = () => location.pathname.startsWith('/checkout');

  return (
    <Show when={!onCheckoutPage()}>
      <ScreenTooSmall />
      <UnsupportedBrowser />
    </Show>
  );
}

function App() {
  const RouterComponent = window.desktop ? HashRouter : Router;
  return (
    <RouterComponent
      root={(props) => (
        <ColorModeProvider initialColorMode="dark">
          <AppContextMenu>
            <AuthProvider>
              {props.children}
              <BootSplash />
              <Show when={agentSetupOpen()}>
                <ModelLoginPage onDismiss={closeAgentSetup} />
              </Show>
              <UpgradeDialog />
              <PurchaseSuccess />
              <EditorApi />
            </AuthProvider>
          </AppContextMenu>
          <Toaster />
          <EnvironmentOverlays />
          <PersistRoute />
        </ColorModeProvider>
      )}
    >
      <Route path="/auth/callback" component={AuthCallbackPage} />
      <Route path="/" component={() => <AuthGate><DashboardPage /></AuthGate>} />
      <Route path="/projects/*ref" component={() => <AuthGate><ProjectPage /></AuthGate>} />
      <Route path="*404" component={NotFoundPage} />
    </RouterComponent>
  );
}

export default App;
