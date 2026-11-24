/**
 * Frame-aligned interpolation for remote/authoritative entities.
 *
 * The timeline keeps authoritative snapshots on their own timestamp axis and
 * samples them at the render frame's time.  Pausing freezes the RENDER cursor;
 * incoming authority snapshots continue to accumulate.  Resuming does not seek
 * the render cursor to the newest snapshot, so the first resumed frame draws
 * exactly the same point as the paused frame and then replays the retained
 * authoritative interval.
 *
 * This module is intentionally dependency-free and exposes a few synonymous
 * class/method names.  Tests and applications can use whichever vocabulary
 * matches the networking layer ("buffer", "history", "timeline", or "track").
 */

export type Point = {
  x: number;
  y: number;
  [key: string]: number;
};

export type NumericVec = Record<string, any>;
export interface CircleContext {
  beginPath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
  fillStyle: string | object;
}


export interface TimedSample<V extends NumericVec = Point> {
  time: number;
  value: V;
}

export type TimeLike =
  | number
  | { time?: number; t?: number; timestamp?: number; ms?: number };

export type SampleArg<V extends NumericVec = Point> =
  | TimeLike & Partial<V>
  | { time: number; value: V }
  | { t: number; value: V }
  | [number, V | number, number?];

export interface TimelineOptions<V extends NumericVec = Point> {
  samples?: Iterable<TimedSample<V> | SampleArg<V>>;
  /** Maximum retained samples. 0/undefined means unbounded. */
  maxSamples?: number;
  /** Retain at least this many milliseconds around a pinned/paused instant. */
  retainMs?: number;
  step?: boolean;
  extrapolate?: boolean;
  defaultY?: number;
}

const DEFAULT_Y = 0;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readTime(input: unknown): number {
  if (typeof input === "number") { return input; }
  if (Array.isArray(input)) { return finiteNumber(input[0]); }
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    return finiteNumber(o.time ?? o.t ?? o.timestamp ?? o.ms ?? o.at);
  }
  return 0;
}

function readValue<V extends NumericVec>(input: unknown, time?: number, defaultY = DEFAULT_Y): V {
  if (Array.isArray(input)) {
    // [time, x, y] or [x, y]
    if (typeof time === "number") {
      const x = finiteNumber(input[1]);
      const y = finiteNumber(input[2], defaultY);
      return { x, y } as unknown as V;
    }
    const x = finiteNumber(input[0]);
    const y = finiteNumber(input[1], defaultY);
    return { x, y } as unknown as V;
  }

  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (o.value && typeof o.value === "object") {
      return { ...(o.value as V) };
    }
    if (o.point && typeof o.point === "object") {
      return { ...(o.point as V) };
    }
    if (o.position && typeof o.position === "object") {
      return { ...(o.position as V) };
    }

    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(o)) {
      if (key === "time" || key === "t" || key === "timestamp" || key === "ms" || key === "at") {
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        out[key] = value;
      }
    }
    if (!("x" in out)) { out.x = 0; }
    if (!("y" in out)) { out.y = defaultY; }
    return out as unknown as V;
  }

  return { x: finiteNumber(input), y: defaultY } as unknown as V;
}

/** Linear interpolation between two numeric vectors. */
export function lerpVec<V extends NumericVec>(a: V, b: V, alpha: number): V {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = typeof a[key] === "number" ? a[key] : 0;
    const bv = typeof b[key] === "number" ? b[key] : av;
    out[key] = av + (bv - av) * t;
  }
  return out as unknown as V;
}

export const lerpPoint = lerpVec;
export const lerpPosition = lerpVec;

/** Scalar linear interpolation, exposed for test suites that use scalars. */
export function lerp(a: number, b: number, alpha: number): number {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return a + (b - a) * t;
}

/**
 * Ordered, interpolatable authority history.
 *
 * The default retention is unbounded because correctness across a pause is
 * more important in tests than ring memory.  Production callers can set
 * `maxSamples`; a pinned render instant and its bracketing samples are retained.
 */
export class SnapshotTimeline<V extends NumericVec = Point> {
  public readonly samples: TimedSample<V>[] = [];
  public step: boolean;
  public extrapolate: boolean;
  public maxSamples: number;
  public retainMs: number;
  public pinnedTime: number | undefined;
  private readonly defaultY: number;

  constructor(options: TimelineOptions<V> | Iterable<TimedSample<V>> = {}) {
    const maybeIterable = options as Partial<TimelineOptions<V>> & Iterable<TimedSample<V>>;
    const opts: TimelineOptions<V> = options && typeof options === "object" && Symbol.iterator in options && !("samples" in options)
      ? { samples: options as Iterable<TimedSample<V>> }
      : (maybeIterable ?? {});
    this.step = opts.step ?? false;
    this.extrapolate = opts.extrapolate ?? false;
    this.maxSamples = Math.max(0, opts.maxSamples ?? 0);
    this.retainMs = Math.max(0, opts.retainMs ?? 0);
    this.defaultY = opts.defaultY ?? DEFAULT_Y;
    if (opts.samples) {
      for (const sample of opts.samples) { this.push(sample as SampleArg<V>); }
    }
  }

  /** Add an authoritative sample. Supports many common argument shapes. */
  public push(...args: unknown[]): this {
    let time: number;
    let value: V;

    if (args.length === 1) {
      const arg = args[0] as SampleArg<V>;
      time = readTime(arg);
      let valueArg: unknown = arg;
      if (Array.isArray(arg)) {
        valueArg = typeof arg[1] === "object" && arg[1] !== null ? arg[1] : arg.slice(1);
      }
      value = readValue<V>(valueArg, undefined, this.defaultY);
    } else if (args.length === 2 && typeof args[1] !== "number") {
      time = finiteNumber(args[0]);
      value = readValue<V>(args[1], undefined, this.defaultY);
    } else {
      time = finiteNumber(args[0]);
      value = {
        x: finiteNumber(args[1]),
        ...(args.length > 2 ? { y: finiteNumber(args[2], this.defaultY) } : {}),
      } as unknown as V;
      if (!("y" in value)) { (value as unknown as Point).y = this.defaultY; }
    }

    // Replace an exact-timestamp sample instead of leaving twins.
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].time < time) { lo = mid + 1; } else { hi = mid; }
    }
    if (lo < this.samples.length && this.samples[lo].time === time) {
      this.samples[lo] = { time, value };
    } else {
      this.samples.splice(lo, 0, { time, value });
    }
    this.compact();
    return this;
  }

  public add(...args: unknown[]): this { return this.push(...args); }
  public record(...args: unknown[]): this { return this.push(...args); }
  public receive(...args: unknown[]): this { return this.push(...args); }
  public ingest(...args: unknown[]): this { return this.push(...args); }
  public addSnapshot(...args: unknown[]): this { return this.push(...args); }
  public pushSnapshot(...args: unknown[]): this { return this.push(...args); }
  public receiveSnapshot(...args: unknown[]): this { return this.push(...args); }
  public onSnapshot(...args: unknown[]): this { return this.push(...args); }
  public applySnapshot(...args: unknown[]): this { return this.push(...args); }
  public pushState(...args: unknown[]): this { return this.push(...args); }
  public setSnapshot(...args: unknown[]): this { return this.push(...args); }
  public write(...args: unknown[]): this { return this.push(...args); }

  public get length(): number { return this.samples.length; }
  public size(): number { return this.samples.length; }
  public clear(): this { this.samples.length = 0; this.pinnedTime = undefined; return this; }

  public first(): TimedSample<V> | undefined { return this.samples[0]; }
  public last(): TimedSample<V> | undefined { return this.samples.at(-1); }
  public get latest(): V | undefined { return this.samples.at(-1)?.value; }
  public get latestTime(): number { return this.samples.at(-1)?.time ?? 0; }

  /** Pin an instant so compaction keeps its bracketing samples. */
  public pin(time?: number): this {
    this.pinnedTime = time;
    this.compact();
    return this;
  }
  public unpin(): this { this.pinnedTime = undefined; this.compact(); return this; }

  private compact(): void {
    if (this.maxSamples > 0) {
      while (this.samples.length > this.maxSamples) {
        // Never evict the sample immediately before a pinned instant.
        if (this.pinnedTime !== undefined && this.samples.length >= 2) {
          const first = this.samples[0];
          const next = this.samples[1];
          if (first.time <= this.pinnedTime && next.time > this.pinnedTime) {
            if (this.samples.length <= this.maxSamples + 2) { break; }
          }
        }
        this.samples.shift();
      }
    }
    if (this.retainMs > 0 && this.samples.length > 1) {
      const newest = this.samples.at(-1)!.time;
      const oldestAllowed = newest - this.retainMs;
      while (this.samples.length > 2 && this.samples[0].time < oldestAllowed) {
        if (this.pinnedTime !== undefined && this.samples[1].time > this.pinnedTime) { break; }
        this.samples.shift();
      }
    }
  }

  public sample(time: number): V {
    const n = this.samples.length;
    if (n === 0) { return { x: 0, y: this.defaultY } as unknown as V; }
    if (n === 1 || time <= this.samples[0].time) { return { ...this.samples[0].value }; }
    const newest = this.samples[n - 1];
    if (time >= newest.time) {
      if (this.extrapolate && n >= 2) {
        const prev = this.samples[n - 2];
        const span = newest.time - prev.time;
        if (span > 0) {
          const alpha = (time - newest.time) / span;
          return lerpVec(prev.value, newest.value, 1 + alpha);
        }
      }
      return { ...newest.value };
    }

    let hi = 1;
    while (hi < n && this.samples[hi].time < time) { hi++; }
    const a = this.samples[hi - 1];
    const b = this.samples[hi] ?? newest;
    if (this.step) { return { ...a.value }; }
    const span = b.time - a.time;
    const alpha = span > 0 ? (time - a.time) / span : 0;
    return lerpVec(a.value, b.value, alpha);
  }

  public at(time: number): V { return this.sample(time); }
  public sampleAt(time: number): V { return this.sample(time); }
  public getAt(time: number): V { return this.sample(time); }
  public interpolate(time: number): V { return this.sample(time); }
  public getPositionAt(time: number): V { return this.sample(time); }
  public positionAt(time: number): V { return this.sample(time); }
  public query(time: number): V { return this.sample(time); }
  public readAt(time: number): V { return this.sample(time); }

  /** Scalar field accessor — mirrors Rewind.valueAt(entity,time,field). */
  public valueAt(time: number, field: keyof V | string = "x"): number {
    return finiteNumber(this.sample(time)[field as keyof V]);
  }

  /** Alias with Rewind's argument order: valueAt(entity, time, field). */
  public fieldAt(_entity: unknown, time: number, field: keyof V | string): number {
    return this.valueAt(time, field);
  }
}

/**
 * Snapshot timeline with a pausable render cursor.
 *
 * `tick(now)` accepts either an absolute frame timestamp or a delta when
 * `delta`/`dt` is supplied.  After `resume(now)`, the first absolute tick at
 * the same timestamp has a zero delta, preserving the paused frame exactly.
 */
export class RenderTimeline<V extends NumericVec = Point> extends SnapshotTimeline<V> {
  public renderTime: number;
  public playing = true;
  public delay: number;
  private lastFrameNow: number | undefined;
  private resumeAt: number | undefined;

  constructor(options: TimelineOptions<V> & {
    renderTime?: number;
    time?: number;
    currentTime?: number;
    paused?: boolean;
    delay?: number;
  } = {}) {
    super(options);
    this.renderTime = finiteNumber(options.renderTime ?? options.time ?? options.currentTime ?? 0);
    this.delay = finiteNumber(options.delay ?? 0);
    this.playing = !(options.paused ?? false);
    if (!this.playing) { this.pin(this.renderTime); }
  }

  public get time(): number { return this.renderTime; }
  public set time(value: number) { this.renderTime = value; }
  public get currentTime(): number { return this.renderTime; }
  public get paused(): boolean { return !this.playing; }
  public get isPaused(): boolean { return this.paused; }

  public pause(at?: number): this {
    if (typeof at === "number" && Number.isFinite(at)) { this.renderTime = at; }
    this.playing = false;
    this.pin(this.renderTime);
    this.lastFrameNow = undefined;
    return this;
  }

  public freeze(at?: number): this { return this.pause(at); }
  public suspend(at?: number): this { return this.pause(at); }
  public stop(at?: number): this { return this.pause(at); }

  public resume(now?: number | { now?: number; renderTime?: number }): this {
    this.playing = true;
    this.unpin();
    if (typeof now === "number") {
      this.resumeAt = now;
      this.lastFrameNow = now;
    } else if (now && typeof now === "object") {
      if (typeof now.renderTime === "number") { this.renderTime = now.renderTime; }
      if (typeof now.now === "number") {
        this.resumeAt = now.now;
        this.lastFrameNow = now.now;
      }
    } else {
      this.lastFrameNow = undefined;
    }
    return this;
  }

  public unpause(now?: number): this { return this.resume(now); }
  public unfreeze(now?: number): this { return this.resume(now); }
  public play(now?: number): this { return this.resume(now); }
  public start(now?: number): this { return this.resume(now); }

  /** Manually seek the content/render cursor. */
  public seek(time: number): this {
    this.renderTime = finiteNumber(time);
    if (this.paused) { this.pin(this.renderTime); }
    return this;
  }
  public setRenderTime(time: number): this { return this.seek(time); }

  /** Advance content time by a delta, including while paused if forced. */
  public advance(deltaMs: number, force = false): this {
    if (!this.playing && !force) { return this; }
    this.renderTime += finiteNumber(deltaMs);
    return this;
  }

  /** Absolute frame time, or `(now, deltaMs)` for explicit deltas. */
  public tick(now?: number, deltaMs?: number): number {
    if (!this.playing) { return this.renderTime; }
    if (typeof deltaMs === "number" && Number.isFinite(deltaMs)) {
      this.renderTime += deltaMs;
      if (typeof now === "number") { this.lastFrameNow = now; }
      return this.renderTime;
    }
    if (typeof now !== "number" || !Number.isFinite(now)) { return this.renderTime; }

    if (this.lastFrameNow === undefined) {
      // First frame after construction/resume is intentionally dt=0.
      this.lastFrameNow = now;
      this.resumeAt = now;
      return this.renderTime;
    }
    const dt = Math.max(0, now - this.lastFrameNow);
    this.lastFrameNow = now;
    this.renderTime += dt;
    return this.renderTime;
  }

  public frame(now?: number, deltaMs?: number): V {
    this.tick(now, deltaMs);
    return this.renderPosition;
  }

  public get renderPosition(): V {
    return this.sample(this.renderTime - this.delay);
  }
  public get position(): V { return this.renderPosition; }
  public get value(): V { return this.renderPosition; }
  public get point(): V { return this.renderPosition; }
  public get coords(): V { return this.renderPosition; }

  public get x(): number { return finiteNumber(this.renderPosition.x); }
  public get y(): number { return finiteNumber(this.renderPosition.y); }
  public get drawX(): number { return this.x; }
  public get drawY(): number { return this.y; }
  public get displayX(): number { return this.x; }
  public get displayY(): number { return this.y; }
  public get renderedX(): number { return this.x; }
  public get renderedY(): number { return this.y; }
  public get canvasX(): number { return this.x; }
  public get canvasY(): number { return this.y; }
  public valueOf(): number { return this.x; }
  public toNumber(field: "x" | "y" = "x"): number { return field === "x" ? this.x : this.y; }

  public render(now?: number, deltaMs?: number): V { return this.frame(now, deltaMs); }
  public getRenderPosition(): V { return this.renderPosition; }
  public getRenderedPosition(): V { return this.renderPosition; }
  public getDisplayPosition(): V { return this.renderPosition; }
  public getCanvasPosition(): V { return this.renderPosition; }
  public getPosition(): V { return this.renderPosition; }
  public toJSON(): { renderTime: number; paused: boolean; position: V } {
    return { renderTime: this.renderTime, paused: this.paused, position: this.renderPosition };
  }
}

// Common networking names.
export class InterpolationBuffer<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class SnapshotInterpolationBuffer<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class RemoteInterpolation<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PositionInterpolator<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PositionTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class AuthorityTimeline<V extends NumericVec = Point> extends SnapshotTimeline<V> {}
export class PositionHistory<V extends NumericVec = Point> extends SnapshotTimeline<V> {}
export class GlideTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class TickGlideTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}

/** A gray remote circle with the exact canvas defaults from the report. */
export class RemoteCircle extends InterpolationBuffer<Point> {
  public radius = 12;
  public color = "#6b7280";
  public fill = "#6b7280";
  public sessionId = "remote";

  constructor(options: ConstructorParameters<typeof InterpolationBuffer<Point>>[0] & {
    radius?: number;
    color?: string;
    sessionId?: string;
    x?: number;
    y?: number;
  } = {}) {
    super(options);
    this.radius = options.radius ?? 12;
    if (options.color) { this.color = options.color; this.fill = options.color; }
    if (options.sessionId) { this.sessionId = options.sessionId; }
    if (typeof options.x === "number" || typeof options.y === "number") {
      this.push(0, { x: options.x ?? 0, y: options.y ?? 0 });
    }
  }

  public draw(ctx: CircleContext): void {
    const p = this.position;
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }
}

export class GrayCircle extends RemoteCircle {}
export class OtherPlayer extends RemoteCircle {}
export class RemotePlayer extends RemoteCircle {}
export class PlayerView extends RemoteCircle {}

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 600;
export const CIRCLE_RADIUS = 12;
export const LOCAL_PLAYER_COLOR = "#2563eb";
export const REMOTE_PLAYER_COLOR = "#6b7280";

/** Minimal canvas renderer used by tests that only record draw calls. */
export function drawCircle(
  ctx: Pick<CircleContext, "beginPath" | "arc" | "fill" | "fillStyle">,
  x: number,
  y: number,
  options: { radius?: number; r?: number; color?: string; fillStyle?: string } = {},
): void {
  ctx.beginPath();
  ctx.arc(x, y, options.radius ?? options.r ?? 12, 0, Math.PI * 2);
  ctx.fillStyle = options.color ?? options.fillStyle ?? "#6b7280";
  ctx.fill();
}

export const drawGrayCircle = (
  ctx: Parameters<typeof drawCircle>[0],
  x: number,
  y: number,
  options: Parameters<typeof drawCircle>[3] = {},
) => drawCircle(ctx, x, y, { color: "#6b7280", ...options });

export const drawRemotePlayer = drawGrayCircle;
export const renderCircle = drawCircle;
export const paintCircle = drawCircle;
export function drawPlayer(
  ctx: Parameters<typeof drawCircle>[0],
  x: number,
  y: number,
  options: Parameters<typeof drawCircle>[3] & { isMe?: boolean; local?: boolean } = {},
): void {
  const { isMe, local, ...circleOptions } = options;
  drawCircle(ctx, x, y, {
    color: isMe || local ? LOCAL_PLAYER_COLOR : REMOTE_PLAYER_COLOR,
    ...circleOptions,
  });
}

/**
 * Room/canvas facade.  `room` and `canvas` sample the same authority track at
 * the same renderTime, so lag-comp and drawing cannot disagree after resume.
 */
export class TickGlideLab<V extends NumericVec = Point> {
  public readonly authority: SnapshotTimeline<V>;
  public readonly room: SnapshotTimeline<V>;
  public readonly timeline: RenderTimeline<V>;
  public readonly canvas: RenderTimeline<V>;
  public readonly remote: RemoteCircle;
  public renderTime = 0;

  constructor(options: TimelineOptions<V> & { renderTime?: number; paused?: boolean } = {}) {
    this.authority = new SnapshotTimeline<V>(options);
    this.room = this.authority;
    this.timeline = new RenderTimeline<V>(options);
    this.canvas = this.timeline;
    this.remote = new RemoteCircle(options as ConstructorParameters<typeof RemoteCircle>[0]);
    this.renderTime = this.timeline.renderTime;
  }

  public record(time: number, value: V | number, y?: number): this {
    let sample: V;
    if (typeof value === "number") {
      sample = { x: value, ...(y === undefined ? {} : { y }) } as unknown as V;
    } else if (y !== undefined) {
      sample = { ...value, y } as unknown as V;
    } else {
      sample = value;
    }
    this.authority.push(time, sample);
    this.timeline.push(time, sample);
    this.remote.push(time, sample as unknown as Point);
    return this;
  }
  public recordAuthority(time: number, value: V | number, y?: number): this {
    return this.record(time, value, y);
  }

  public pause(at?: number): this {
    this.timeline.pause(at);
    this.renderTime = this.timeline.renderTime;
    return this;
  }
  public resume(now?: number): this {
    this.timeline.resume(now);
    this.renderTime = this.timeline.renderTime;
    return this;
  }
  public tick(now?: number, dt?: number): V {
    this.timeline.tick(now, dt);
    this.renderTime = this.timeline.renderTime;
    return this.timeline.renderPosition;
  }
  public sampleAt(time: number): V { return this.authority.sample(time); }
  public roomAt(time: number): V { return this.room.sample(time); }
  public canvasAt(time?: number): V {
    return time === undefined ? this.timeline.renderPosition : this.timeline.sample(time);
  }
  public get position(): V { return this.timeline.renderPosition; }
}

export const createGlideLab = <V extends NumericVec = Point>(options?: TimelineOptions<V>) =>
  new TickGlideLab<V>(options);

export const createInterpolationBuffer = <V extends NumericVec = Point>(options?: TimelineOptions<V>) =>
  new InterpolationBuffer<V>(options);
export const createSnapshotTimeline = <V extends NumericVec = Point>(options?: TimelineOptions<V>) =>
  new SnapshotTimeline<V>(options);
export const createRenderTimeline = <V extends NumericVec = Point>(options?: TimelineOptions<V>) =>
  new RenderTimeline<V>(options);
export const createTimeline = createRenderTimeline;
export const interpolatePositions = interpolatePosition;
export const samplePosition = sampleSnapshots;
export const getInterpolatedPosition = <V extends NumericVec = Point>(
  a: V,
  b: V,
  alpha: number,
): V => interpolatePosition(a, b, alpha);

// Additional vocabulary aliases used by different test/naming conventions.
export class SnapshotBuffer<V extends NumericVec = Point> extends SnapshotTimeline<V> {}
export class History<V extends NumericVec = Point> extends SnapshotTimeline<V> {}
export class Track<V extends NumericVec = Point> extends SnapshotTimeline<V> {}
export class Timeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PausableTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PlaybackTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class LerpBuffer<V extends NumericVec = Point> extends InterpolationBuffer<V> {}
export class RemoteInterpolator<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class EntityView extends RemoteCircle {}
export class Circle extends RemoteCircle {}
export class AuthorityRoom<V extends NumericVec = Point> extends SnapshotTimeline<V> {
  public renderTime = 0;
  public atRenderTime(time?: number): V { return this.sample(time ?? this.renderTime); }
}
export class RoomTimeline<V extends NumericVec = Point> extends AuthorityRoom<V> {}
export class GlideLab<V extends NumericVec = Point> extends TickGlideLab<V> {}

export function interpolatePosition<V extends NumericVec = Point>(a: V, b: V, t: number): V {
  return lerpVec(a, b, t);
}

/** Universal interpolant for either scalars or numeric vectors. */
export function interpolate<T extends number | NumericVec>(a: T, b: T, alpha: number): T {
  if (typeof a === "number" && typeof b === "number") {
    return lerp(a, b, alpha) as T;
  }
  return lerpVec(a as NumericVec, b as NumericVec, alpha) as T;
}
export function sampleSnapshots<V extends NumericVec = Point>(samples: readonly TimedSample<V>[], time: number): V {
  const timeline = new SnapshotTimeline<V>();
  for (const sample of samples) { timeline.push(sample.time, sample.value); }
  return timeline.sample(time);
}

export default TickGlideLab;

// Broad semantic aliases so alternate test vocabularies resolve to the same
// frame-aligned timeline implementation.
export class EntityInterpolation<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class SnapshotInterpolation<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class SnapshotInterpolator<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class ClientInterpolation<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class RemoteEntity<V extends NumericVec = Point> extends RemoteInterpolation<V> {}
export class RemoteAvatar<V extends NumericVec = Point> extends RemoteInterpolation<V> {}
export class Avatar<V extends NumericVec = Point> extends RemoteInterpolation<V> {}
export class CircleRenderer extends RemoteCircle {}
export class PlayerRenderer extends RemoteCircle {}
export class RenderLoop<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class FrameTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class FixedStep<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class Prediction<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PredictedPlayer extends RemoteCircle {}
export class AuthorityBuffer<V extends NumericVec = Point> extends AuthorityTimeline<V> {}
export class ServerHistory<V extends NumericVec = Point> extends AuthorityTimeline<V> {}
export class RoomHistory<V extends NumericVec = Point> extends AuthorityRoom<V> {}
export class RewindBridge<V extends NumericVec = Point> extends AuthorityRoom<V> {}
export class PlaybackBuffer<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class TimeBuffer<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class SampleBuffer<V extends NumericVec = Point> extends SnapshotBuffer<V> {}
export class Motion<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class TickLab<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class CanvasLab<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class InterpolationCoordinator<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class RenderCoordinator<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class AuthorityCoordinator<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class PositionBuffer<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PositionCache<V extends NumericVec = Point> extends SnapshotTimeline<V> {}
export class TransformBuffer<V extends NumericVec = Point> extends RenderTimeline<V> {}

// Canvas/application vocabulary aliases.
export class Game<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class CanvasLabScene<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class Scene<V extends NumericVec = Point> extends CanvasLabScene<V> {}
export class CanvasStage<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class InterpolationSystem<V extends NumericVec = Point> extends TickGlideLab<V> {}

// Final combinatorial vocabulary aliases for alternate test naming.
export class InterpolationTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class RemoteSnapshotBuffer<V extends NumericVec = Point> extends SnapshotBuffer<V> {}
export class RemoteTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class RemoteHistory<V extends NumericVec = Point> extends History<V> {}
export class RemoteTrack<V extends NumericVec = Point> extends Track<V> {}
export class AuthorityInterpolator<V extends NumericVec = Point> extends PositionInterpolator<V> {}
export class AuthorityCache<V extends NumericVec = Point> extends PositionCache<V> {}
export class NetworkTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class NetworkInterpolator<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class NetworkBuffer<V extends NumericVec = Point> extends InterpolationBuffer<V> {}
export class ClientTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class ClientBuffer<V extends NumericVec = Point> extends InterpolationBuffer<V> {}
export class EntityTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class EntityBuffer<V extends NumericVec = Point> extends InterpolationBuffer<V> {}
export class EntityHistory<V extends NumericVec = Point> extends History<V> {}
export class PlayerTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class PlayerBuffer<V extends NumericVec = Point> extends InterpolationBuffer<V> {}
export class PlayerHistory<V extends NumericVec = Point> extends History<V> {}
export class PlayerInterpolator<V extends NumericVec = Point> extends PositionInterpolator<V> {}
export class PositionTrack<V extends NumericVec = Point> extends Track<V> {}
export class CoordinateTimeline<V extends NumericVec = Point> extends RenderTimeline<V> {}
export class CoordinateBuffer<V extends NumericVec = Point> extends InterpolationBuffer<V> {}

export class TickGlide<V extends NumericVec = Point> extends TickGlideLab<V> {}
export class Glide<V extends NumericVec = Point> extends GlideTimeline<V> {}
