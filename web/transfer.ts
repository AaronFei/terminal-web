import { PASTE_DEBUG } from './config.js';
import { termArea } from './dom.js';
import { activeSession, isActive } from './state.js';
import { flashStatus, showStatus } from './status.js';
import { domPrompt } from './overlays.js';

// ---------------------------------------------------------------------------
// File paste / drag-drop / picker -> upload -> insert the saved path into the
// active session, so the program running there (e.g. Claude Code) can read it.
// Any file type works, not just images.
// ---------------------------------------------------------------------------
function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Upload via XMLHttpRequest (not fetch): fetch exposes no upload-progress
// events, so a big file (e.g. 75 MB) just sat on "uploading…" with no feedback.
// xhr.upload.onprogress lets us show a live percentage, and parsing the server's
// JSON {error} surfaces *why* an upload failed (e.g. "file too large") instead
// of a generic message. Never rejects — always resolves so callers can `void` it.
export function uploadFile(file: Blob, name?: string): Promise<void> {
  return new Promise((resolve) => {
    if (!file) {
      resolve();
      return;
    }
    // Bind the destination to the tab that's active NOW, at upload start — the
    // file belongs to the terminal you attached it from. onload can fire much
    // later (a big upload, or you switched tabs / backgrounded the app while it
    // ran); using the live activeSession there sent the path to whatever tab
    // happened to be active on completion — the wrong one, or none you were
    // looking at. sendSeq buffers it if that tab's socket is mid-reconnect.
    const target = activeSession;
    const label = name ?? 'file';
    showStatus(`uploading ${label}… 0%`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload' + (name ? `?name=${encodeURIComponent(name)}` : ''));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (e): void => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        showStatus(
          `uploading ${label}… ${pct}% (${fmtMB(e.loaded)}/${fmtMB(e.total)} MB)`,
        );
      } else {
        showStatus(`uploading ${label}… ${fmtMB(e.loaded)} MB`);
      }
    };
    // All bytes are sent; the server is now writing the file and replying.
    xhr.upload.onload = (): void => showStatus(`uploading ${label}… finishing…`);

    xhr.onload = (): void => {
      let data: { path?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        /* non-JSON response */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.path) {
        if (target) {
          // Quote the path if it contains whitespace; append a space so it reads
          // as a complete argument at the prompt.
          const p = /\s/.test(data.path)
            ? `'${data.path.replace(/'/g, `'\\''`)}'`
            : data.path;
          target.sendSeq(p + ' ');
          if (isActive(target)) target.focus();
        }
        // If it landed on a tab you've since switched away from, name it so you
        // know where the path went instead of it seeming to vanish.
        const where = target && !isActive(target) ? ` → ${target.displayName}` : '';
        flashStatus(`file added${where}: ${data.path}`, 2500);
      } else {
        flashStatus(
          data.error ? `upload failed: ${data.error}` : 'file upload failed',
          3500,
        );
      }
      resolve();
    };
    xhr.onerror = (): void => {
      flashStatus('file upload failed', 2500);
      resolve();
    };
    xhr.send(file);
  });
}

// Pull a file off the host back to this device — the reverse of uploadFile. A
// HEAD pre-check turns a bad path into a toast instead of silently saving the
// server's 404 body as a file; the real GET then streams through a transient
// <a download> so large files never buffer in memory. Auth rides on the
// same-origin tw_auth cookie automatically.
async function downloadFromHost(rawPath: string): Promise<void> {
  const p = rawPath.trim();
  if (!p) return;
  // Pass the active session so the server can resolve a relative path against
  // that terminal's current working directory (no absolute path needed).
  const sess = activeSession?.name;
  const url =
    '/api/download?path=' + encodeURIComponent(p) + (sess ? '&session=' + encodeURIComponent(sess) : '');
  showStatus(`preparing ${p}…`);
  let head: Response;
  try {
    head = await fetch(url, { method: 'HEAD' });
  } catch {
    flashStatus('download failed (network)', 2500);
    return;
  }
  if (!head.ok) {
    const why =
      head.status === 404 ? 'not found' : head.status === 400 ? 'bad path' : `error ${head.status}`;
    flashStatus(`download failed: ${why}`, 3000);
    return;
  }
  const size = Number(head.headers.get('content-length') ?? '0');
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = p.split('/').pop() || 'download';
  document.body.append(a);
  a.click();
  a.remove();
  flashStatus(`downloading ${a.download}${size ? ` (${fmtMB(size)} MB)` : ''}…`, 2500);
}

// Ask for a path and download it. A bare filename / relative path resolves
// against the terminal's current directory (server-side), so no absolute path
// is needed — handy on mobile. Shared by the desktop ⬇ button and the mobile
// actions sheet.
export function promptDownload(): void {
  void (async () => {
    const p = await domPrompt({
      label: "Download — a filename or relative path (from the terminal's folder), or a full path",
      value: '',
      okText: 'Download',
    });
    if (p) void downloadFromHost(p);
  })();
}

export function initPasteUpload(): void {
  // Capture phase: xterm's own paste handler calls stopPropagation() on its
  // textarea/element, so a bubble-phase listener would never see pastes made into
  // the focused terminal. Capturing lets us intercept file pastes first. Any file
  // kind is uploaded; plain-text pastes fall through to xterm untouched.
  window.addEventListener(
    'paste',
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (PASTE_DEBUG) {
        const cd = e.clipboardData;
        let kinds = '(no items)';
        if (items) {
          const parts: string[] = [];
          for (let i = 0; i < items.length; i += 1) parts.push(`${items[i].kind}/${items[i].type}`);
          kinds = parts.length ? parts.join(',') : '(empty)';
        }
        const types = cd && cd.types ? Array.from(cd.types).join('|') : '(none)';
        activeSession?.debugSend(
          'paste',
          `types=[${types}] items=[${kinds}] files=${cd?.files?.length ?? 0}`,
        );
      }
      const dt = e.clipboardData;
      if (!dt) return;

      // (1) Real file items — macOS image paste, Win+Shift+S screenshots, any
      // copied file (any type is allowed). (2) Fall back to dt.files, which some
      // browsers populate even when the items list doesn't expose the file.
      const files: File[] = [];
      if (items) {
        for (let i = 0; i < items.length; i += 1) {
          if (items[i].kind === 'file') {
            const f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length === 0 && dt.files) {
        for (let i = 0; i < dt.files.length; i += 1) files.push(dt.files[i]);
      }
      if (files.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation(); // don't let xterm also handle it
        for (const f of files) void uploadFile(f, f.name);
        return;
      }

      // (3) Windows-Chrome case: copying an image from a web page (or Office)
      // often delivers it ONLY as text/html (an <img src="data:...">) with NO
      // file item, so the checks above find nothing. Recover the embedded image
      // by parsing the HTML and fetching a data:/blob: src into a Blob. Remote
      // http(s)/file: srcs can't be fetched client-side (CORS/security), so those
      // fall through to xterm's normal text paste.
      const html = dt.getData ? dt.getData('text/html') : '';
      if (html) {
        const src =
          new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') ??
          '';
        if (src.startsWith('data:image/') || src.startsWith('blob:')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void (async () => {
            try {
              const blob = await fetch(src).then((r) => r.blob());
              if (blob.type.startsWith('image/')) {
                const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
                await uploadFile(blob, `pasted-image.${ext}`);
              }
            } catch {
              flashStatus('paste: could not read the image', 2500);
            }
          })();
          return;
        }
        if (PASTE_DEBUG && src) {
          activeSession?.debugSend('paste', `unfetchable img src=${src.slice(0, 48)}`);
        }
      }
      // Nothing uploadable: let xterm handle the (text) paste.
    },
    true,
  );
}

function dragHasFile(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.items.length; i += 1) {
    if (dt.items[i].kind === 'file') return true;
  }
  return false;
}

export function initDragDrop(): void {
  termArea.addEventListener('dragover', (e) => {
    if (!dragHasFile(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    termArea.classList.add('dragging');
  });
  termArea.addEventListener('dragleave', () => termArea.classList.remove('dragging'));
  termArea.addEventListener('drop', (e) => {
    termArea.classList.remove('dragging');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (const f of Array.from(files)) void uploadFile(f, f.name);
  });
}
