import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConversationSummary, Message, MessageStatus } from '@friendstar/shared';
import { LIMITS } from '@friendstar/shared';
import { cn, formatBytes, formatListTime, formatTime, linkify, messagePreview } from '../../lib/format.ts';
import { Avatar, CountBadge, IconButton } from '../ui/index.tsx';
import { Icon } from '../ui/Icon.tsx';

/* ---------- Status ticks ---------- */
const STATUS_LABEL: Record<MessageStatus, string> = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Not sent',
};

/** sending = clock · sent = one tick · delivered = two ticks · read = two amber ticks */
export function StatusTicks({ status, className }: { status: MessageStatus; className?: string }) {
  const label = STATUS_LABEL[status];
  if (status === 'sending') return <Icon name="clock" size={13} className={cn('opacity-70', className)} aria-label={label} role="img" />;
  if (status === 'failed') return <Icon name="alert" size={14} className={cn('text-danger', className)} aria-label={label} role="img" />;
  const double = status !== 'sent';
  return (
    <svg
      width={double ? 18 : 13}
      height={13}
      viewBox={double ? '0 0 18 12' : '0 0 13 12'}
      role="img"
      aria-label={label}
      className={cn(status === 'read' ? 'text-star' : 'opacity-75', className)}
    >
      <title>{label}</title>
      <path d="M1.5 6.5 4.8 9.8 11.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {double && (
        <path d="M7.6 8.6 8.8 9.8 15.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/* ---------- Typing dots ---------- */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="typing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="typing-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

/* ---------- Conversation row ---------- */
export function ConversationItem({
  conversation: c,
  meId,
  active,
  typing,
  onClick,
}: {
  conversation: ConversationSummary;
  meId: string;
  active?: boolean;
  typing?: boolean;
  onClick: () => void;
}) {
  const last = c.lastMessage;
  const mine = last?.senderId === meId;
  const isGroup = c.kind === 'group';
  const senderName =
    isGroup && last && last.kind !== 'system'
      ? mine
        ? 'You'
        : (c.group?.members.find((u) => u.id === last.senderId)?.displayName.split(' ')[0] ?? null)
      : null;
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition',
        active ? 'bg-primary-soft' : 'hover:bg-surface-2',
      )}
    >
      <Avatar name={c.peer.displayName} src={c.peer.avatarUrl} online={isGroup ? null : c.peer.online} group={isGroup} size={52} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold">{c.peer.displayName}</span>
          {last && (
            <span className={cn('shrink-0 text-xs', c.unreadCount ? 'font-semibold text-primary' : 'text-muted')}>
              {formatListTime(last.createdAt)}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cn('flex min-w-0 flex-1 items-center gap-1 text-sm', c.unreadCount ? 'font-medium text-ink' : 'text-muted')}>
            {typing ? (
              <span className="flex items-center gap-1.5 text-primary">
                typing <TypingDots />
              </span>
            ) : (
              <>
                {mine && last && last.kind !== 'system' && <StatusTicks status={last.status} className="shrink-0" />}
                <span className="truncate">
                  {senderName && <span className="font-semibold">{senderName}: </span>}
                  {messagePreview(last) || (isGroup ? 'Group created' : 'Say hello 👋')}
                </span>
              </>
            )}
          </span>
          <CountBadge count={c.unreadCount} />
        </span>
      </span>
    </button>
  );
}

/* ---------- Message bubble ---------- */
export function MessageBubble({
  message: m,
  mine,
  highlight,
  onRetry,
  onOpenImage,
  senderName,
}: {
  message: Message;
  mine: boolean;
  highlight?: boolean;
  /** Shown above the first bubble of a run in group chats. */
  senderName?: string | null;
  onRetry?: () => void;
  onOpenImage?: (url: string) => void;
}) {
  const meta = (
    <span className={cn('ml-2 inline-flex translate-y-0.5 items-center gap-1 text-[11px]', mine ? 'text-white/75' : 'text-muted')}>
      {formatTime(m.createdAt)}
      {mine && <StatusTicks status={m.status} />}
    </span>
  );

  if (m.kind === 'system') {
    return (
      <div id={`msg-${m.id}`} className="my-2 flex justify-center px-6">
        <span className="rounded-full bg-surface/90 px-3 py-1 text-center text-xs font-medium text-muted shadow-sm">{m.body}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${m.id}`} className={cn('pop-in flex px-3 py-0.5', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[82%] rounded-3xl px-3.5 py-2 shadow-sm sm:max-w-[70%]',
          mine ? 'bubble-own rounded-br-lg' : 'bubble-other rounded-bl-lg border border-line/60',
          highlight && 'flash',
          m.status === 'failed' && 'opacity-80',
        )}
      >
        {senderName && !mine && <p className="mb-0.5 text-[13px] font-bold" style={{ color: nameColor(m.senderId) }}>{senderName}</p>}
        {m.kind === 'image' && m.file && (m.file.url ? (
          <button
            type="button"
            onClick={() => onOpenImage?.(m.file!.url)}
            className="-mx-1.5 -mt-0.5 mb-1 block overflow-hidden rounded-2xl"
            aria-label={`Open image ${m.file.name}`}
          >
            <img
              src={m.file.url}
              alt={m.file.name}
              loading="lazy"
              className="max-h-80 w-full min-w-40 object-cover"
              style={m.file.width && m.file.height ? { aspectRatio: `${m.file.width} / ${m.file.height}` } : undefined}
            />
          </button>
        ) : <div className="mb-1 rounded-xl bg-surface-2 px-3 py-4 text-sm text-muted">Photo · connect to view</div>)}
        {m.kind === 'file' && m.file && (
          m.file.mimeType.startsWith('audio/') ? (
            m.file.url ? <audio controls preload="metadata" src={m.file.url} aria-label={`Voice message from ${m.file.name}`} className="mb-1 block max-w-full" /> :
              <p className="mb-1 text-sm text-muted">Voice message · connect to listen</p>
          ) : (
          m.file.url ? (
          <a
            href={m.status === 'sending' ? undefined : `${m.file.url}${m.file.url.includes('?') ? '&' : '?'}download=1`}
            download={m.file.name}
            className={cn('mb-1 flex items-center gap-3 rounded-2xl p-2.5', mine ? 'bg-white/15' : 'bg-surface-2')}
          >
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', mine ? 'bg-white/20' : 'bg-primary-soft text-primary')}>
              <Icon name="file" size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{m.file.name}</span>
              <span className={cn('text-xs', mine ? 'text-white/75' : 'text-muted')}>{formatBytes(m.file.size)}</span>
            </span>
            <Icon name="download" size={18} className="shrink-0 opacity-80" />
          </a>
          ) : (
            <div className="mb-1 flex items-center gap-3 rounded-2xl bg-surface-2 p-2.5 text-sm text-muted">
              <Icon name="file" size={20} />
              <span className="min-w-0"><span className="block truncate font-semibold">{m.file.name}</span><span className="text-xs">Connect to download</span></span>
            </div>
          )
          )
        )}
        {m.body ? (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">
            {linkify(m.body).map((part, i) =>
              part.href ? (
                <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  {part.text}
                </a>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
            {meta}
          </p>
        ) : (
          <div className="flex justify-end">{meta}</div>
        )}
        {m.status === 'failed' && onRetry && (
          <button onClick={onRetry} className="mt-1 text-xs font-semibold underline">
            Not sent — tap to retry
          </button>
        )}
      </div>
    </div>
  );
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="sticky top-2 z-10 my-3 flex justify-center">
      <span className="rounded-full bg-surface/90 px-3 py-1 text-xs font-semibold text-muted shadow-sm backdrop-blur">{label}</span>
    </div>
  );
}

/* ---------- Composer ---------- */
export function Composer({
  disabled,
  disabledReason,
  onSend,
  onSendFile,
  onGenerateImage,
  onTyping,
  onRecording,
}: {
  disabled?: boolean;
  disabledReason?: string;
  onSend: (text: string) => void;
  onSendFile: (file: File, caption: string) => void;
  onGenerateImage?: (prompt: string) => Promise<void>;
  onTyping: (typing: boolean) => void;
  onRecording: (recording: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [recordError, setRecordError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recordingLimit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingSignal = useRef(onRecording);
  recordingSignal.current = onRecording;

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (recordingLimit.current) clearTimeout(recordingLimit.current);
    recordingSignal.current(false);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function toggleVoiceRecording() {
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
      return;
    }
    setRecordError('');
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecordError('Voice recording is not supported by this browser.');
      return;
    }
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = audioStream;
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((mime) => MediaRecorder.isTypeSupported(mime));
      const activeRecorder = preferred ? new MediaRecorder(audioStream, { mimeType: preferred }) : new MediaRecorder(audioStream);
      recorder.current = activeRecorder;
      chunks.current = [];
      activeRecorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      activeRecorder.onstop = () => {
        const mimeType = (activeRecorder.mimeType || preferred || 'audio/webm').split(';')[0]!;
        const blob = new Blob(chunks.current, { type: mimeType });
        if (blob.size > LIMITS.attachmentBytes) setRecordError('Voice note is larger than the 10 MiB message limit.');
        else if (blob.size) {
          const extension = mimeType === 'audio/mp4' ? 'm4a' : 'webm';
          setFile(new File([blob], `voice-note-${Date.now()}.${extension}`, { type: mimeType }));
        }
        audioStream.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        if (recordingLimit.current) clearTimeout(recordingLimit.current);
        recordingLimit.current = null;
        setRecording(false);
        recordingSignal.current(false);
      };
      activeRecorder.start(250);
      setRecording(true);
      recordingSignal.current(true);
      recordingLimit.current = setTimeout(() => {
        if (activeRecorder.state === 'recording') activeRecorder.stop();
      }, 5 * 60 * 1000);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      setRecordError('Microphone access is unavailable. Allow microphone access in your device settings and try again.');
    }
  }

  // Auto-grow the textarea up to ~6 lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  function stopTyping() {
    if (isTyping.current) {
      isTyping.current = false;
      onTyping(false);
    }
  }
  function handleChange(v: string) {
    setText(v);
    if (!isTyping.current && v.trim()) {
      isTyping.current = true;
      onTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2500);
  }

  function submit() {
    const body = text.trim();
    if (disabled) return;
    if (file) {
      onSendFile(file, body);
      setFile(null);
    } else if (body) {
      onSend(body);
    } else return;
    setText('');
    stopTyping();
    area.current?.focus();
  }

  async function generateFromPrompt() {
    const prompt = text.trim();
    if (!onGenerateImage || !prompt || file || generatingImage) return;
    setGeneratingImage(true);
    try {
      await onGenerateImage(prompt);
      setText('');
      stopTyping();
    } catch {
      /* The chat page reports the server error. */
    } finally {
      setGeneratingImage(false);
      area.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends on devices with a physical keyboard; Shift+Enter adds a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      submit();
    }
  }

  if (disabled) {
    return (
      <div className="safe-bottom border-t border-line bg-surface px-4 py-4 text-center text-sm text-muted">
        {disabledReason ?? 'You can’t send messages in this chat.'}
      </div>
    );
  }

  return (
    <div className="safe-bottom border-t border-line bg-surface/95 px-2 py-2 backdrop-blur sm:px-3">
      {file && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl bg-surface-2 p-2">
          {preview ? (
            <img src={preview} alt="" className="h-14 w-14 rounded-xl object-cover" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary-soft text-primary">
              <Icon name={file.type.startsWith('audio/') ? 'mic' : 'file'} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{file.name}</span>
              <span className="text-xs text-muted">{file.type.startsWith('audio/') ? 'Voice note · tap send to share' : `${formatBytes(file.size)} · add a caption below (optional)`}</span>
          </span>
          <IconButton icon="x" label="Remove attachment" onClick={() => setFile(null)} />
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <IconButton icon="clip" label="Attach a photo or file" onClick={() => fileInput.current?.click()} className="mb-0.5" />
        <IconButton icon={recording ? 'micOff' : 'mic'} label={recording ? 'Stop voice note' : 'Record voice note'} onClick={() => void toggleVoiceRecording()} disabled={Boolean(file)} className={recording ? 'mb-0.5 text-danger' : 'mb-0.5'} />
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="image/jpeg,image/png,image/gif,image/webp,audio/webm,audio/mp4,application/pdf,text/plain,text/csv,application/zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) setFile(f);
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          maxLength={LIMITS.messageBody}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={onKey}
          onBlur={stopTyping}
          placeholder={file ? 'Add a caption…' : 'Write a message…'}
          aria-label="Message"
          className="scroll-thin max-h-40 min-h-11 flex-1 resize-none rounded-3xl border border-line bg-bg px-4 py-2.5 text-[15px] leading-snug text-ink outline-none transition focus:border-primary/50"
        />
        {onGenerateImage && (
          <IconButton
            icon="sparkles"
            label="Generate AI image (one per person daily, five across FriendStar per day)"
            title="AI image · one per person/day · five total/day"
            onClick={() => void generateFromPrompt()}
            disabled={!text.trim() || generatingImage || Boolean(file)}
            className="mb-0.5 text-primary"
          />
        )}
        <button
          onClick={submit}
          disabled={(!text.trim() && !file) || generatingImage}
          aria-label="Send"
          className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary shadow-md shadow-primary/30 transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
        >
          {generatingImage ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Icon name="send" size={19} />}
        </button>
      </div>
      {recordError && <p className="px-12 pt-1 text-xs text-danger">{recordError}</p>}
    </div>
  );
}

const NAME_HUES = [262, 18, 200, 150, 330, 45, 280, 175];
function nameColor(id: string) {
  const hue = NAME_HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % NAME_HUES.length];
  return `hsl(${hue} 62% 52%)`;
}
