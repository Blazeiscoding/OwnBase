// The pixel landscape behind the hero and the footer. It is drawn at a quarter
// of the CSS resolution (a third on phones) and scaled up without smoothing.
//
// Orange is your server, the cabin's window. Gold is the people connected to
// it: a house across town, a boat, a train and a city on the horizon. In the
// hero, the cabin lights first and an arc reaches each of the others in turn.
// With reduced motion the scene is drawn once, everything already connected.
//
// A classic script rather than a module, so the page also works opened
// straight from disk.

const HOST = [249, 115, 22];
const HOST_HI = [255, 186, 112];
const GOLD = [255, 210, 122];
const GOLD_DIM = [206, 156, 82];
const UNLIT = [52, 44, 70];
const FOG = [236, 238, 244];

const SKIES = {
  dusk: [
    "#141136",
    "#1b1745",
    "#241d52",
    "#30235e",
    "#3f2a68",
    "#553374",
    "#733e7f",
    "#97497f",
    "#bd5a80",
    "#df767f",
    "#f29a7c",
  ],
  night: [
    "#0b0a20",
    "#100e2b",
    "#151236",
    "#1b1641",
    "#221a4b",
    "#2b2055",
    "#36265e",
    "#442c66",
    "#55326b",
  ],
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const pack = (c) => ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
const unpack = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise over 0..1, `cells` bumps across. */
function noise(rand, cells) {
  const v = Array.from({ length: cells + 2 }, rand);
  return (t) => {
    const x = Math.min(Math.max(t, 0), 1) * cells;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return v[i] * (1 - s) + v[i + 1] * s;
  };
}

const VARIANTS = {
  hero: { sky: "dusk", horizon: 0.68, fade: "bottom", reveal: true, seed: 7 },
  end: { sky: "night", horizon: 0.6, fade: "top", reveal: false, seed: 31 },
  // The 404 page: a link that goes nowhere, so the arc to the house stops short.
  lost: { sky: "night", horizon: 0.62, fade: "none", reveal: false, seed: 53, broken: "house" },
};

/** The least land, in CSS pixels, worth drawing under the words. */
const LAND_MIN = 230;

class Scene {
  constructor(canvas, variant, chips = []) {
    this.canvas = canvas;
    this.cfg = VARIANTS[variant];
    this.chips = chips;
    // The words over the scene: its land is drawn below them, never behind.
    this.root = canvas.closest("[data-scene-root]");
    this.words = this.root?.querySelector("[data-scene-clear]") ?? null;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.visible = true;
    this.start = performance.now();
    this.last = 0;
    this.packets = [];
    this.nextPacket = 0;
    this.build();
    this.observe();
  }

  observe() {
    let timer;
    const resized = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => this.build(), 120);
    });
    resized.observe(this.canvas);
    // The words change height as the fonts arrive and the download note fills in.
    if (this.words) resized.observe(this.words);
    new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.loop();
    }).observe(this.canvas);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.loop();
    });
  }

  /**
   * Where the words end, in CSS pixels from the top of the scene, with room
   * for the arcs that rise above the horizon. When that leaves less land
   * than LAND_MIN, the scene asks its root to grow, through --land-clear.
   */
  clearance() {
    if (!this.words || !this.root) return 0;
    const top = this.canvas.getBoundingClientRect().top;
    const words = this.words.getBoundingClientRect().bottom - top;
    if (words <= 0) return 0;
    const below = words + Math.max(28, this.canvas.clientHeight * 0.05);
    this.root.style.setProperty("--land-clear", `${Math.ceil(below + LAND_MIN)}px`);
    return below;
  }

  build() {
    const clear = this.clearance();
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return;
    this.clear = clear;
    const px = cssW < 700 ? 3 : 4;
    const W = Math.ceil(cssW / px);
    const H = Math.ceil(cssH / px);
    this.px = px;
    this.W = W;
    this.H = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.image = this.ctx.createImageData(W, H);
    this.frame = new Uint32Array(this.image.data.buffer);
    this.base = new Uint32Array(W * H);
    this.layout();
    this.paint();
    this.placeChips();
    this.draw(this.still ? Infinity : performance.now() - this.start);
  }

  // Where everything goes, in canvas pixels.
  layout() {
    const { W, H, cfg } = this;
    const rand = random(cfg.seed);
    const narrow = W < 240;
    const L = {};
    const horizon = Math.round(H * (narrow && cfg.fade === "bottom" ? 0.7 : cfg.horizon));
    // Lower, when the words above reach further down than that.
    L.horizon = Math.max(horizon, Math.ceil(this.clear / this.px));
    // The land below the horizon is laid out in shares of itself, so it keeps
    // its look wherever the horizon falls; at the hero's 0.68 these shares are
    // the fractions of the whole it always used.
    const land = H - L.horizon;
    L.water = L.horizon + Math.max(10, Math.round(land * 0.22));

    // Two ranges: a hazy one behind, a dark one in front that rises on the
    // left, behind the headline, and drops away to show the afterglow.
    const farN = [noise(rand, 5), noise(rand, 13)];
    const nearN = [noise(rand, 4), noise(rand, 11), noise(rand, 29)];
    const heroLeft = cfg.fade === "bottom" && !narrow;
    L.far = new Int16Array(W);
    L.near = new Int16Array(W);
    for (let x = 0; x < W; x++) {
      const t = x / W;
      const far = 0.7 * farN[0](t) + 0.3 * farN[1](t);
      L.far[x] = L.horizon - Math.round(H * (0.05 + 0.09 * far));
      let lift = 0.04 + 0.08 * (0.6 * nearN[0](t) + 0.3 * nearN[1](t) + 0.1 * nearN[2](t));
      if (heroLeft) lift += 0.23 * Math.max(0, 1 - Math.max(0, t - 0.4) / 0.32) ** 1.5;
      L.near[x] = L.horizon - Math.round(H * lift);
    }

    // The near shore, and the knoll the cabin stands on.
    const midN = [noise(rand, 6), noise(rand, 17)];
    const groundN = [noise(rand, 5), noise(rand, 19)];
    L.cabinX = Math.round(W * (narrow ? 0.7 : 0.64));
    L.mid = new Int16Array(W);
    L.ground = new Int16Array(W);
    for (let x = 0; x < W; x++) {
      const t = x / W;
      L.mid[x] = L.water - Math.round(land * 0.09 * (0.7 * midN[0](t) + 0.3 * midN[1](t)));
      const knoll = Math.exp(-(((x - L.cabinX) / (W * 0.14)) ** 2));
      L.ground[x] =
        L.horizon +
        Math.round(land * 0.69) -
        Math.round(land * 0.06 * (0.7 * groundN[0](t) + 0.3 * groundN[1](t))) -
        Math.round(land * 0.23 * knoll);
    }

    L.moon = narrow
      ? {
          x: Math.round(W * 0.88),
          y: Math.round(H * (cfg.fade === "top" ? 0.095 : 0.135)),
          r: Math.max(4, Math.round(H * 0.022)),
        }
      : { x: Math.round(W * 0.84), y: Math.round(H * 0.16), r: Math.max(5, Math.round(H * 0.035)) };
    // On a phone the host's card sits left of the cabin, so the house moves to its right.
    L.houseX = Math.round(W * (narrow ? 0.92 : 0.26));
    L.boatX = Math.round(W * (narrow ? 0.42 : 0.44));
    L.city = { x0: Math.round(W * (narrow ? 0.74 : 0.77)), x1: Math.round(W * 0.97) };
    this.L = L;

    // Stars, kept off the mountains and the moon.
    const starRand = random(cfg.seed + 1);
    this.stars = [];
    const count = Math.round((W * H) / (cfg.sky === "night" ? 260 : 380));
    for (let i = 0; i < count; i++) {
      const x = Math.floor(starRand() * W);
      const y = Math.floor(starRand() ** 1.6 * L.horizon * 0.85);
      if (y >= Math.min(L.far[x], L.near[x]) - 2) continue;
      if (Math.hypot(x - L.moon.x, y - L.moon.y) < L.moon.r * 2.4) continue;
      this.stars.push({
        x,
        y,
        b: starRand(),
        p: starRand() * Math.PI * 2,
        s: 0.6 + starRand() * 1.8,
      });
    }
  }

  // The parts that never change, into `base`.
  paint() {
    const { W, H, L, cfg, base } = this;
    const set = (x, y, c) => {
      if (x >= 0 && y >= 0 && x < W && y < H) base[y * W + x] = pack(c);
    };
    const get = (x, y) => unpack(base[y * W + x]);
    const rand = random(cfg.seed + 2);

    // Sky: a stepped gradient, ordered-dithered between neighbouring steps.
    const stops = SKIES[cfg.sky].map(hex);
    const skyAt = (y, x) => {
      const p = Math.min(Math.max(y / L.horizon, 0), 0.9999) * (stops.length - 1);
      const i = Math.floor(p);
      return p - i > bayer(x, y) ? stops[Math.min(i + 1, stops.length - 1)] : stops[i];
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, skyAt(y, x));

    // The moon, a crescent with a dithered halo.
    const { moon } = L;
    for (let y = moon.y - moon.r * 3; y <= moon.y + moon.r * 3; y++) {
      for (let x = moon.x - moon.r * 3; x <= moon.x + moon.r * 3; x++) {
        if (y < 0 || x < 0 || x >= W) continue;
        const d = Math.hypot(x - moon.x, y - moon.y);
        const bite = Math.hypot(x - moon.x + moon.r * 0.55, y - moon.y + moon.r * 0.35);
        if (d <= moon.r && bite > moon.r * 0.92)
          set(x, y, d > moon.r - 1 ? [226, 214, 196] : [248, 238, 214]);
        else if (d > moon.r && d <= moon.r * 1.7) set(x, y, mix(get(x, y), [160, 136, 200], 0.16));
        else if (d > moon.r * 1.7 && d <= moon.r * 2.5)
          set(x, y, mix(get(x, y), [160, 136, 200], 0.07));
      }
    }

    // Mountains.
    const farC = cfg.sky === "night" ? [44, 34, 78] : [92, 62, 116];
    const nearC = cfg.sky === "night" ? [24, 20, 50] : [44, 33, 78];
    for (let x = 0; x < W; x++) {
      for (let y = L.far[x]; y <= L.horizon; y++)
        set(x, y, y === L.far[x] ? mix(farC, [150, 110, 150], 0.35) : farC);
      for (let y = L.near[x]; y <= L.horizon; y++) set(x, y, nearC);
      // A little texture on the near range: dithered darker patches.
      for (let y = L.near[x] + 2; y <= L.horizon; y++) {
        if (bayer(x, y) < 0.12 && rand() < 0.5) set(x, y, mix(nearC, [20, 16, 40], 0.4));
      }
    }

    // The city: towers with a few lit windows. The tallest holds a node.
    const cityC = cfg.sky === "night" ? [18, 15, 38] : [33, 25, 62];
    let tallest = { h: 0 };
    for (let x = L.city.x0; x < L.city.x1;) {
      const w = 3 + Math.floor(rand() * 5);
      const span = (x - L.city.x0) / (L.city.x1 - L.city.x0);
      const h = Math.round(H * (0.025 + 0.075 * rand() * Math.sin(Math.PI * span) ** 0.6));
      for (let bx = x; bx < x + w && bx < W; bx++) {
        for (let y = L.horizon - h; y <= L.horizon; y++) set(bx, y, cityC);
      }
      for (let wy = L.horizon - h + 2; wy < L.horizon - 1; wy += 2) {
        for (let wx = x + 1; wx < x + w - 1; wx += 2) {
          if (rand() < 0.28) set(wx, wy, rand() < 0.5 ? GOLD_DIM : [150, 112, 70]);
        }
      }
      if (h > tallest.h) tallest = { h, x: x + Math.floor(w / 2), w };
      x += w + (rand() < 0.3 ? 1 : 0);
    }
    // A mast on the tallest tower.
    for (let y = L.horizon - tallest.h - 4; y < L.horizon - tallest.h; y++)
      set(tallest.x, y, cityC);
    L.cityNode = { x: tallest.x, y: L.horizon - tallest.h + 3 };

    // Water: the sky reflected, darker, with the shore line along the horizon.
    for (let y = L.horizon + 1; y < H; y++) {
      const depth = y - L.horizon;
      const from = Math.max(0, L.horizon - Math.round(depth * 2.6));
      for (let x = 0; x < W; x++)
        set(x, y, mix(skyAt(from, x + depth), [16, 22, 48], 0.38 + depth * 0.012));
    }
    for (let x = 0; x < W; x++) set(x, L.horizon, cityC);
    // City lights, smeared down into the water.
    for (let x = L.city.x0; x < L.city.x1; x++) {
      if (rand() < 0.3)
        for (let y = L.horizon + 2; y < L.horizon + 6; y += 2)
          set(x, y, mix(GOLD_DIM, [40, 40, 70], 0.55));
    }

    // The boat: a hull, a mast and an unlit lantern (a node).
    const boatY = L.horizon + Math.round((L.water - L.horizon) * 0.55);
    const hull = [24, 19, 40];
    for (let i = -4; i <= 4; i++) set(L.boatX + i, boatY, hull);
    for (let i = -3; i <= 3; i++) set(L.boatX + i, boatY + 1, hull);
    for (let y = boatY - 6; y < boatY; y++) set(L.boatX, y, [60, 50, 80]);
    set(L.boatX + 1, boatY - 3, [60, 50, 80]);
    L.boatNode = { x: L.boatX + 2, y: boatY - 3 };

    // The far shore of hills with pines, and a house holding a node.
    const hillC = cfg.sky === "night" ? [17, 34, 44] : [29, 58, 72];
    const pineC = cfg.sky === "night" ? [10, 24, 32] : [19, 42, 54];
    for (let x = 0; x < W; x++) for (let y = L.mid[x]; y < H; y++) set(x, y, hillC);
    for (let x = 2; x < W - 2; x++) {
      if (rand() > 0.16) continue;
      const h = 4 + Math.floor(rand() * 6);
      const gy = L.mid[x];
      for (let i = 0; i < h; i++) {
        const half = Math.floor(((h - i) / h) * 2.4);
        for (let dx = -half; dx <= half; dx++) set(x + dx, gy - i, pineC);
      }
    }

    // The near ground, speckled, with grass along its edge.
    const groundC = cfg.sky === "night" ? [12, 24, 31] : [19, 40, 50];
    for (let x = 0; x < W; x++) {
      for (let y = L.ground[x]; y < H; y++) {
        set(
          x,
          y,
          bayer(x * 3 + y, y) < 0.04 && rand() < 0.5 ? mix(groundC, [38, 70, 80], 0.3) : groundC,
        );
      }
      if (rand() < 0.35) set(x, L.ground[x] - 1, mix(groundC, [40, 78, 80], 0.5));
    }

    // A house across town, holding a node.
    {
      const gx = L.houseX;
      const gy = Math.max(L.ground[gx - 4], L.ground[gx + 4]);
      const wall = [44, 35, 62];
      const plank = [37, 29, 53];
      const roof = [26, 20, 42];
      for (let y = gy - 6; y <= Math.max(gy, L.ground[gx]); y++) {
        for (let x = gx - 5; x <= gx + 5; x++) set(x, y, (gy - y) % 2 ? wall : plank);
      }
      for (let i = 0; i < 5; i++)
        for (let x = gx - 7 + i; x <= gx + 7 - i; x++)
          set(x, gy - 7 - i, i === 4 ? [58, 44, 74] : roof);
      for (let y = gy - 3; y <= gy; y++) for (let x = gx - 3; x <= gx - 2; x++) set(x, y, roof);
      for (let y = gy - 4; y <= gy - 3; y++)
        for (let x = gx + 2; x <= gx + 3; x++) set(x, y, UNLIT);
      L.houseNode = { x: gx + 3, y: gy - 4 };
    }

    // The cabin, which is the server.
    {
      const cx = L.cabinX;
      const gy = L.ground[cx];
      const wall = [44, 34, 58];
      const plank = [36, 27, 48];
      const roof = [24, 18, 36];
      for (let y = gy - 8; y <= gy; y++) {
        for (let x = cx - 7; x <= cx + 7; x++) set(x, y, (gy - y) % 2 ? wall : plank);
      }
      for (let i = 0; i < 6; i++) {
        for (let x = cx - 9 + i; x <= cx + 9 - i; x++)
          set(x, gy - 9 - i, i === 5 ? [62, 46, 76] : roof);
      }
      for (let y = gy - 17; y <= gy - 12; y++)
        for (let x = cx + 4; x <= cx + 5; x++) set(x, y, roof);
      for (let y = gy - 4; y <= gy; y++) for (let x = cx + 2; x <= cx + 4; x++) set(x, y, roof);
      // The antenna.
      for (let y = gy - 22; y <= gy - 15; y++) set(cx - 3, y, [74, 60, 92]);
      for (let x = cx - 4; x <= cx - 2; x++) set(x, gy - 19, [74, 60, 92]);
      L.window = { x: cx - 5, y: gy - 6, w: 4, h: 3 };
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) set(cx - 5 + x, gy - 6 + y, UNLIT);
      L.hostNode = { x: cx - 3, y: gy - 23 };
      L.chimney = { x: cx + 4, y: gy - 18 };
    }

    // The edge that dissolves into the page, unless the scene is the whole page.
    const band = cfg.fade === "none" ? 0 : Math.max(6, Math.round(H * 0.045));
    const fadeRand = random(cfg.seed + 3);
    for (let i = 0; i < band; i++) {
      const y = cfg.fade === "bottom" ? H - band + i : band - 1 - i;
      const level = (i + 1) / band;
      for (let x = 0; x < W; x++) {
        if (level ** 2 > bayer(x, y) * 0.92 + fadeRand() * 0.08) set(x, y, FOG);
      }
    }
    // A few loose pixels beyond the edge.
    for (let i = 0; i < (band ? W * 0.05 : 0); i++) {
      const x = Math.floor(fadeRand() * W);
      const off = Math.floor(fadeRand() ** 3 * band * 0.6);
      const y = cfg.fade === "bottom" ? H - band - off : band + off;
      if (y > 0 && y < H) set(x, y, FOG);
    }
    this.band = band;

    this.nodes = [
      { name: "house", ...L.houseNode },
      { name: "boat", ...L.boatNode },
      { name: "city", ...L.cityNode },
      { name: "train", x: 0, y: L.horizon - 2 },
    ];
  }

  placeChips() {
    const { px, L } = this;
    const at = { host: L.hostNode, house: L.houseNode, city: L.cityNode, boat: L.boatNode };
    for (const chip of this.chips) {
      const node = at[chip.dataset.anchor];
      if (!node) continue;
      chip.style.left = `${(node.x + 0.5) * px}px`;
      chip.style.top = `${(node.y + 0.5) * px}px`;
    }
  }

  loop() {
    if (this.still || this.running) return;
    this.running = true;
    const tick = (now) => {
      if (!this.visible || document.hidden) {
        this.running = false;
        return;
      }
      // About 20 frames a second is plenty for pixel art.
      if (now - this.last > 48) {
        this.last = now;
        this.draw(now - this.start);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** One frame, `t` milliseconds after the page loaded. */
  draw(t) {
    if (!this.frame) return;
    const { W, H, L, frame, cfg } = this;
    frame.set(this.base);
    const sec = t / 1000;
    const still = !Number.isFinite(t);
    const blend = (x, y, c, a) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      frame[i] = pack(mix(unpack(frame[i]), c, a));
    };
    const set = (x, y, c) => blend(x, y, c, 1);

    // Stars.
    for (const s of this.stars) {
      const tw = still ? 1 : 0.65 + 0.35 * Math.sin(sec * s.s + s.p);
      const b = s.b * tw;
      if (b < 0.25) continue;
      blend(s.x, s.y, [255, 244, 226], b > 0.75 ? 0.95 : b > 0.5 ? 0.6 : 0.35);
      if (s.b > 0.93) {
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          blend(s.x + dx, s.y + dy, [255, 244, 226], 0.25 * tw);
      }
    }

    // The moon on the water, broken into moving streaks.
    for (let y = L.horizon + 2; y < L.water; y += 2) {
      const len = 2 + ((y * 7) % 5);
      const shift = still ? 0 : Math.round(Math.sin(sec * 1.3 + y * 0.9) * 2);
      for (let i = 0; i < len; i++)
        blend(
          L.moon.x - (len >> 1) + i + shift,
          y,
          [236, 220, 200],
          0.45 - (y - L.horizon) * 0.012,
        );
    }

    // The train runs along the far shore, carriages lit.
    const trainLen = 4 * 10;
    const speed = 5; // canvas pixels a second
    const loopLen = W + trainLen + 40;
    const tx = still
      ? Math.round(W * 0.47)
      : Math.round(((sec * speed + W * 0.22 + trainLen + 20) % loopLen) - trainLen - 20);
    const body = [30, 23, 50];
    for (let car = 0; car < 4; car++) {
      const x0 = tx + car * 10;
      const tall = car === 3 ? 4 : 3;
      for (let x = x0; x < x0 + 9; x++) {
        for (let y = L.horizon - tall; y < L.horizon; y++) set(x, y, body);
      }
      if (car < 3) for (let x = x0 + 1; x < x0 + 8; x += 2) set(x, L.horizon - 2, GOLD_DIM);
      else set(x0 + 8, L.horizon - 2, [255, 236, 190]);
    }
    const trainNode = this.nodes[3];
    trainNode.x = tx + 14;
    trainNode.y = L.horizon - 2;

    // Smoke from the chimney.
    if (!still) {
      for (let i = 0; i < 5; i++) {
        const age = (sec * 0.6 + i / 5) % 1;
        blend(
          L.chimney.x + Math.round(Math.sin(age * 5 + i) * 1.5 + age * 4),
          L.chimney.y - Math.round(age * 12),
          [150, 140, 170],
          0.45 * (1 - age),
        );
      }
    }

    // The sequence: the cabin lights, then an arc reaches each node in turn.
    const REVEAL = cfg.reveal && !still;
    const hostOn = REVEAL ? t > 500 : true;
    const arcStart = (i) => 1100 + i * 650;
    const ARC = 700;
    const progress = (i) => (REVEAL ? Math.min(Math.max((t - arcStart(i)) / ARC, 0), 1) : 1);

    if (hostOn) {
      const flicker = REVEAL && t < 700 && Math.floor(t / 60) % 2 === 0;
      const w = L.window;
      if (!flicker) {
        // Light spilling out of the window, in steps.
        const cx = w.x + w.w / 2;
        const cy = w.y + w.h / 2;
        for (let y = cy - 14; y <= cy + 14; y++) {
          for (let x = cx - 16; x <= cx + 16; x++) {
            const d = Math.hypot((x - cx) * 0.8, y - cy);
            if (d > 14) continue;
            const a = Math.ceil((1 - d / 14) * 3) / 3;
            if (a * 0.5 > bayer(Math.round(x), Math.round(y))) blend(x, y, HOST, 0.16 * a + 0.04);
          }
        }
        for (let y = 0; y < w.h; y++)
          for (let x = 0; x < w.w; x++) set(w.x + x, w.y + y, x === 1 && y === 1 ? HOST_HI : HOST);
        set(w.x + 2, w.y, [180, 80, 20]);
        set(w.x + 2, w.y + 1, [180, 80, 20]);
        set(w.x + 2, w.y + 2, [180, 80, 20]);
      }
      // The antenna's light blinks.
      if (still || Math.floor(sec * 1.2) % 2 === 0) set(L.hostNode.x, L.hostNode.y + 1, HOST_HI);
    }

    const lit = [];
    this.nodes.forEach((node, i) => {
      const p = node.name === cfg.broken ? Math.min(progress(i), 0.5) : progress(i);
      if (p <= 0) return;
      this.arc(L.hostNode, node, p, blend);
      if (p >= 1) lit.push(node.name);
    });

    for (const node of this.nodes) {
      if (!lit.includes(node.name)) continue;
      if (node.name !== "train") {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > 0 && d <= 2.3) blend(node.x + dx, node.y + dy, GOLD, 0.22);
          }
        }
      }
      set(node.x, node.y, GOLD);
      if (node.name === "house") {
        set(node.x - 1, node.y, GOLD);
        set(node.x, node.y + 1, GOLD);
        set(node.x - 1, node.y + 1, GOLD_DIM);
      }
      if (node.name === "boat") {
        for (let y = L.horizon + Math.round((L.water - L.horizon) * 0.55) + 2; y < L.water; y += 2)
          blend(node.x, y, GOLD, 0.5);
      }
    }
    this.announce(lit, hostOn);

    // Messages travelling along the arcs, once everyone who can connect has.
    const reachable = this.nodes.filter((node) => node.name !== cfg.broken);
    if (!still && lit.length === reachable.length) {
      if (t > this.nextPacket) {
        const node = reachable[Math.floor(Math.random() * reachable.length)];
        this.packets.push({ node, born: t, out: Math.random() < 0.5 });
        this.nextPacket = t + 700 + Math.random() * 900;
      }
      this.packets = this.packets.filter((p) => t - p.born < 1300);
      for (const p of this.packets) {
        const k = (t - p.born) / 1300;
        const u = p.out ? k : 1 - k;
        for (let trail = 0; trail < 3; trail++) {
          const v = Math.min(Math.max(u + (p.out ? -1 : 1) * trail * 0.012, 0), 1);
          const [x, y] = this.point(L.hostNode, p.node, v);
          blend(x, y, [255, 246, 222], trail === 0 ? 1 : 0.5 - trail * 0.15);
          if (trail === 0) blend(x + 1, y, [255, 246, 222], 0.8);
        }
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
  }

  point(a, b, u) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const cx = (a.x + b.x) / 2;
    const cy = Math.min(a.y, b.y) - Math.min(dist * 0.3, this.H * 0.07);
    const v = 1 - u;
    return [v * v * a.x + 2 * v * u * cx + u * u * b.x, v * v * a.y + 2 * v * u * cy + u * u * b.y];
  }

  /** A dotted arc from the server to a node, orange at the cabin, gold at the far end. */
  arc(a, b, p, blend) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(dist * 1.6);
    let last = null;
    let n = 0;
    for (let i = 0; i <= steps * p; i++) {
      const u = i / steps;
      const [x, y] = this.point(a, b, u);
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (key === last) continue;
      last = key;
      if (n++ % 3 === 2) continue;
      blend(x, y, mix(HOST, GOLD, u), 0.7);
    }
  }

  /** Tells the page which people have connected, so their cards can appear. */
  announce(lit, hostOn) {
    const key = `${hostOn}:${lit.join(",")}`;
    if (key === this.announced) return;
    this.announced = key;
    this.canvas.dispatchEvent(new CustomEvent("connected", { detail: { lit, hostOn } }));
  }
}

for (const canvas of document.querySelectorAll("canvas[data-scene]")) {
  const root = canvas.closest("[data-scene-root]") ?? canvas.parentElement;
  const chips = [...root.querySelectorAll("[data-anchor]")];
  const count = root.querySelector("[data-connected]");
  canvas.addEventListener("connected", ({ detail }) => {
    for (const chip of chips) {
      const name = chip.dataset.anchor;
      chip.classList.toggle("is-on", name === "host" ? detail.hostOn : detail.lit.includes(name));
    }
    if (count) {
      const n = detail.lit.length;
      count.textContent = n === 0 ? "nobody" : n === 1 ? "1 person" : `${n} people`;
    }
  });
  const scene = new Scene(canvas, canvas.dataset.scene, chips);
  scene.loop();
}
