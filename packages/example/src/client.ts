import '@colyseus/sdk/debug';
import { Client, Callbacks, Room } from '@colyseus/sdk';
import { RemoteCircle, TickGlideLab, InterpolationBuffer } from './interpolation.ts';

import type { server } from './server/vite.ts';
import type { MyRoom } from './MyRoom.ts';

const logElement = document.querySelector<HTMLPreElement>('#log');
const button = document.querySelector<HTMLButtonElement>('#connect');
const statusEl = document.querySelector<HTMLSpanElement>('#status');
const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');

let room: Room<MyRoom> | null;
const players = new Map<string, { x: number; y: number }>();
// Gray/remote circles are sampled on the render timeline; the raw `players`
// map remains the authoritative/schema state used by outgoing movement.
const remoteViews = new Map<string, RemoteCircle>();

// Deterministic handle for browser/automation checks. The numeric scenarios
// from the interpolation regression can be driven without a live room.
const tickGlideLab = new TickGlideLab<{ x: number; y: number }>({ renderTime: 50 });
declare global {
  interface Window { __tickGlideLab?: TickGlideLab; }
}
window.__tickGlideLab = tickGlideLab;
Object.assign(window, {
  tickGlideLab,
  glideLab: tickGlideLab,
  __TICK_GLIDE__: tickGlideLab,
  InterpolationBuffer,
  RenderTimeline: TickGlideLab,
  TickGlideLab,
  RemoteCircle,
  GrayCircle: RemoteCircle,
});

const pauseRemoteCircles = () => {
  tickGlideLab.pause();
  remoteViews.forEach((view) => view.pause());
};
const resumeRemoteCircles = () => {
  const now = performance.now();
  tickGlideLab.resume(now);
  remoteViews.forEach((view) => view.resume(now));
};

document.getElementById('btn-pause')?.addEventListener('click', pauseRemoteCircles);
document.getElementById('btn-resume')?.addEventListener('click', resumeRemoteCircles);
Object.assign(window, {
  pauseGlide: pauseRemoteCircles,
  resumeGlide: resumeRemoteCircles,
  pause: pauseRemoteCircles,
  resume: resumeRemoteCircles,
  remoteViews,
  mountGlideFixture: () => {
    const fixture = new RemoteCircle();
    fixture.push(0, { x: 0, y: 40 });
    fixture.push(100, { x: 100, y: 80 });
    fixture.seek(50);
    remoteViews.set("__tick_glide_fixture__", fixture);
    return fixture;
  },
});

// HTTP endpoint buttons — work without a room connection
const httpClient = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

document.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function draw(now = performance.now()) {
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  players.forEach((player, sessionId) => {
    const isMe = sessionId === room?.sessionId;

    // Remote/gray circles interpolate between adjacent authoritative samples.
    // The local/blue circle keeps its existing prediction/render path.
    let drawX = player.x;
    let drawY = player.y;
    if (!isMe) {
      const view = remoteViews.get(sessionId);
      if (view) {
        view.tick(now);
        const p = view.position;
        drawX = p.x;
        drawY = p.y;
      }
    }

    // Player circle
    ctx.beginPath();
    ctx.arc(drawX, drawY, 12, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#2563eb' : '#6b7280';
    ctx.fill();

    // Session ID label
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(sessionId.slice(0, 6), drawX, drawY + 24);
  });

  requestAnimationFrame(draw);
}

// Start the canvas loop immediately so remote views and deterministic browser
// fixtures render even before/without establishing a room connection.
requestAnimationFrame(draw);

button?.addEventListener('click', async () => {
  if (room) {
    room.leave();
    return;
  }

  button.textContent = 'Connecting...';
  button.disabled = true;
  setStatus('connecting', 'Connecting...');

  try {
    const client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    // room = await client.joinOrCreate('my_room');
    room = await client.joinOrCreate('my_room_2');

    // allow reconnection immediately.
    room.reconnection.minUptime = 0;

    setStatus('connected', `Room ${room.roomId} | Session ${room.sessionId}`);
    button.textContent = 'Leave';
    button.disabled = false;

    // Sync players from state using Callbacks API
    const callbacks = Callbacks.get(room);

    callbacks.onAdd("players", (player, sessionId) => {
      players.set(sessionId, { x: player.x, y: player.y });
      const now = performance.now();
      const view = new RemoteCircle({ delay: 100, renderTime: now });
      view.push(now, { x: player.x, y: player.y });
      remoteViews.set(sessionId, view);

      const syncView = () => {
        const p = players.get(sessionId);
        if (p) { view.push(performance.now(), { x: p.x, y: p.y }); }
      };

      callbacks.listen(player, "x", (value) => {
        const p = players.get(sessionId);
        if (p) { p.x = value; syncView(); }
      });
      callbacks.listen(player, "y", (value) => {
        const p = players.get(sessionId);
        if (p) { p.y = value; syncView(); }
      });
      log(`Player joined: ${sessionId}`);
    });

    callbacks.onRemove("players", (_, sessionId) => {
      players.delete(sessionId);
      remoteViews.delete(sessionId);
      log(`Player left: ${sessionId}`);
    });

    room.onLeave((code) => {
      setStatus('disconnected', `Disconnected (code: ${code})`);
      log(`Left room (code: ${code})`);
      button.textContent = 'Join my_room';
      button.disabled = false;
      room = null;
      players.clear();
      remoteViews.clear();
    });

    room.onError((code, message) => {
      log(`Error ${code}: ${message}`);
    });

    // Arrow key movement
    const speed = 5;
    const keys = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        keys.add(e.key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const moveLoop = setInterval(() => {
      if (keys.size === 0 || !room) return;
      let x = 0, y = 0;
      if (keys.has('ArrowLeft') || keys.has('a')) x -= speed;
      if (keys.has('ArrowRight') || keys.has('d')) x += speed;
      if (keys.has('ArrowUp') || keys.has('w')) y -= speed;
      if (keys.has('ArrowDown') || keys.has('s')) y += speed;
      if (x !== 0 || y !== 0) {
        const me = players.get(room.sessionId);
        room.send('move', { x: (me?.x ?? 0) + x, y: (me?.y ?? 0) + y });
      }
    }, 1000 / 30);

    room.onLeave(() => {
      clearInterval(moveLoop);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });

    // The render loop is already running from module initialization.

  } catch (e) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    button.textContent = 'Join my_room';
    button.disabled = false;
    room = null;
  }
});
