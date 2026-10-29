import { Icon } from './ui/Icon.tsx';

/** Direct-install beta APK hosted with the web app. */
export function DownloadBanner() {
  return (
    <aside className="shrink-0 border-b border-primary/20 bg-primary-soft px-3 py-2 text-primary" role="region" aria-label="FriendStar Android app download">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 sm:flex-row">
        <div className="flex min-w-0 items-center gap-2 text-center sm:text-left">
          <Icon name="download" size={18} />
          <div className="min-w-0">
            <p className="text-sm font-bold">Get FriendStar for Android</p>
            <p className="text-[11px] leading-tight text-muted">Direct-install beta build · not from Google Play</p>
          </div>
        </div>
        <a
          href="/FriendStar.apk"
          download="FriendStar.apk"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:opacity-90"
          aria-label="Download the FriendStar Android beta APK"
        >
          <Icon name="download" size={16} />
          Download APK
        </a>
      </div>
    </aside>
  );
}
