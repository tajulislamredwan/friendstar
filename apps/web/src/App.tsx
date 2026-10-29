import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { isDemo } from './api/index.ts';
import { AppShell } from './components/layout/index.tsx';
import { Logo, Spinner } from './components/ui/index.tsx';
import { ForgotPasswordPage, LoginPage, PasswordResetPage, RegisterPage, WelcomePage } from './pages/auth.tsx';
import { ChatRoomPage, ChatsLayout, NewChatPage, NoChatSelected, PeerProfilePage } from './pages/chats.tsx';
import { NotificationsPage, SearchPage } from './pages/misc.tsx';
import { NewGroupPage } from './pages/groups.tsx';
import { StatusComposerPage, StatusPage, StatusViewerPage } from './pages/status.tsx';
import { CallsPage } from './pages/calls.tsx';
import { InvitePage, PeoplePage } from './pages/people.tsx';
import { AdminPage } from './pages/admin.tsx';
import { installAudioUnlock } from './lib/audio.ts';
import {
  AppearanceSettingsPage,
  OfflineReplySettingsPage,
  NotificationSettingsPage,
  PrivacySettingsPage,
  ProfileSettingsPage,
  SettingsPage,
} from './pages/settings/index.tsx';
import { useAuth, useTheme } from './store/index.ts';

function Splash() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-bg">
      <Logo size={72} />
      <Spinner className="text-primary" />
    </div>
  );
}

export const RETURN_KEY = 'fs_after_login';
function RequireAuth() {
  const status = useAuth((s) => s.status);
  const { pathname } = useLocation();
  if (status === 'loading') return <Splash />;
  if (status !== 'authed') {
    // Shared profile links survive the sign-in / sign-up detour.
    if (pathname.startsWith('/u/')) sessionStorage.setItem(RETURN_KEY, pathname);
    return <Navigate to="/welcome" replace />;
  }
  return <Outlet />;
}

function GuestOnly() {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <Splash />;
  return status === 'guest' ? <Outlet /> : <Navigate to="/" replace />;
}

// The static preview has no server-side SPA fallback, so it uses hash URLs.
const Router = isDemo ? HashRouter : BrowserRouter;

export default function App() {
  const init = useAuth((s) => s.init);
  useTheme(); // applies the saved theme
  useEffect(() => {
    void init();
    if (!isDemo && 'serviceWorker' in navigator && location.protocol === 'https:') {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
    return installAudioUnlock();
  }, [init]);

  return (
    <Router>
      <Routes>
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route element={<GuestOnly />}>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route element={<ChatsLayout />}>
              <Route index element={<NoChatSelected />} />
              <Route path="chats/:id" element={<ChatRoomPage />} />
              <Route path="chats/:id/info" element={<PeerProfilePage />} />
              <Route path="new" element={<NewChatPage />} />
              <Route path="groups/new" element={<NewGroupPage />} />
            </Route>
            <Route path="search" element={<SearchPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="status" element={<StatusPage />} />
            <Route path="status/new" element={<StatusComposerPage />} />
            <Route path="status/view/:userId" element={<StatusViewerPage />} />
            <Route path="calls" element={<CallsPage />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="u/:code" element={<InvitePage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="soon" element={<Navigate to="/" replace />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/profile" element={<ProfileSettingsPage />} />
            <Route path="settings/privacy" element={<PrivacySettingsPage />} />
            <Route path="settings/offline-reply" element={<OfflineReplySettingsPage />} />
            <Route path="settings/appearance" element={<AppearanceSettingsPage />} />
            <Route path="settings/notifications" element={<NotificationSettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
