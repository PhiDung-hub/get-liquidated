<script lang="ts">
  import jsQR from 'jsqr';
  import { linkBlobOf } from '$lib/session/link';
  import { ui } from './state.svelte';

  let { onlink }: { onlink: (blob: string) => void } = $props();
  let video: HTMLVideoElement;
  let error = $state('');
  let pasted = $state('');
  const NOT_A_LINK = 'not a Get Liquidated link';

  // jsQR runs on the main thread, so frames are scaled down to at most 640px a side before it reads them.
  function decode(ctx: CanvasRenderingContext2D) {
    const { videoWidth: vw, videoHeight: vh } = video;
    if (!vw || !vh) return;
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    const [w, h] = [Math.round(vw * scale), Math.round(vh * scale)];
    ctx.canvas.width = w;
    ctx.canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (!code) return;
    const blob = linkBlobOf(code.data);
    if (blob) onlink(blob);
    else error = NOT_A_LINK;
  }

  // The stream is stopped on every way out: close, scrim, a decoded link (which swaps this sheet for the PIN sheet).
  $effect(() => {
    let stream: MediaStream | undefined;
    let closed = false;
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const timer = setInterval(() => stream && decode(ctx), 200);
    const camera = navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 } }, audio: false }) ?? Promise.reject(new Error('no camera API'));
    camera
      .then((s) => {
        stream = s;
        if (closed) return s.getTracks().forEach((t) => t.stop());
        video.srcObject = s;
        return video.play();
      })
      .catch((e: Error) => (error = `Camera unavailable (${e.message}). Paste the link instead.`));
    return () => {
      closed = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  });

  function paste(e: SubmitEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    const blob = linkBlobOf(pasted);
    if (blob) onlink(blob);
    else error = NOT_A_LINK;
  }

  const close = () => (ui.overlay = null);
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" aria-label="Scan link" data-testid="link-scan-sheet">
  <button class="x" aria-label="Close" onclick={close}>✕</button>
  <h3>Scan link</h3>
  <p class="dim">Point the camera at the QR on the desktop.</p>
  <video bind:this={video} muted playsinline data-testid="link-scan-video"></video>
  {#if error}<p class="sell" data-testid="link-scan-error">{error}</p>{/if}
  <form onsubmit={paste}>
    <input type="text" inputmode="url" autocomplete="off" placeholder="or paste the link" aria-label="Paste link" data-testid="link-paste" bind:value={pasted} />
    <button class="confirm" data-testid="link-paste-go" disabled={!pasted}>Use</button>
  </form>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(400px, calc(100vw - 32px)); padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); line-height: 1; }
  .x:hover { color: var(--bright); }
  h3 { margin: 0; font-size: calc(var(--fs) * 1.667); font-weight: 400; color: var(--bright); text-align: center; }
  p { margin: 0; text-align: center; }
  video { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: var(--radius); background: var(--bg); }
  form { display: flex; gap: 8px; }
  input { flex: 1; height: var(--ctl); padding: 0 12px; }
  .confirm { padding: 0 16px; border-radius: var(--radius); background: var(--accent); color: var(--bg); }
  @media (max-width: 900px) {
    .modal { inset: auto 0 0; transform: none; width: 100%; max-height: 92vh; overflow-y: auto; border-radius: var(--radius) var(--radius) 0 0; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
  }
</style>
