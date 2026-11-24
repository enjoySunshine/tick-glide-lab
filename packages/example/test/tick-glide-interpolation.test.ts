import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RenderTimeline,
  RewindBridge,
  SnapshotTimeline,
  TickGlideLab,
} from "../src/interpolation.ts";

describe("gray remote circle: render-time interpolation", () => {
  it("lands between two authoritative coordinates at the midpoint", () => {
    const circle = new RenderTimeline();
    circle.push(0, { x: 0, y: 40 });
    circle.push(100, { x: 100, y: 80 });
    circle.seek(50);

    assert.deepEqual(circle.position, { x: 50, y: 60 });
  });

  it("keeps the paused canvas/room point on resume and then continues", () => {
    const lab = new TickGlideLab();
    lab.record(0, { x: 0, y: 40 });
    lab.record(100, { x: 100, y: 80 });
    lab.timeline.seek(50);
    lab.pause(50);

    // Authority keeps moving while the render cursor is frozen.
    for (let t = 150; t <= 750; t += 50) {
      lab.record(t, { x: 100 + (t - 100) * (170 / 650), y: 120 });
    }
    lab.record(850, { x: 270, y: 300 });

    lab.resume(900);
    assert.deepEqual(lab.canvasAt(), { x: 50, y: 60 });
    assert.deepEqual(lab.roomAt(50), { x: 50, y: 60 });

    // Same resumed frame is dt=0.
    lab.tick(900);
    assert.deepEqual(lab.canvasAt(), { x: 50, y: 60 });

    // Subsequent frames replay the retained authoritative interval.
    lab.tick(1000);
    assert.equal(lab.timeline.renderTime, 150);
    assert.ok(lab.position.x > 100);
  });

  it("keeps dense 50 ms authority samples queryable at their exact time", () => {
    const room = new SnapshotTimeline<{ x: number }>();
    for (let time = 1000; time <= 1950; time += 50) {
      room.record(time, { x: (time - 1000) * 0.2 });
    }

    assert.equal(room.valueAt(1050, "x"), 10);
    assert.equal(room.at(1950).x, 190);
  });

  it("exposes the same point through a room-style bridge", () => {
    const room = new RewindBridge();
    room.record(0, { x: 0, y: 40 });
    room.record(100, { x: 100, y: 80 });
    assert.deepEqual(room.at(50), { x: 50, y: 60 });
  });
});
