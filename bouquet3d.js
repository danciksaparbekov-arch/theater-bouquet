/* bouquet3d.js — процедурный 3D-букет (three.js r128, глобальный THREE).
   Состав: кустовые розы, эустома, эрингиум, итальянский рускус; джут, бумага, бант.
   API: window.initBouquet3D(container) → { setWrap(bool), dispose() }
   1 единица сцены ≈ 10 см; точка связки — в начале координат, «перёд» букета — ось +Z. */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var DEG = Math.PI / 180;

  // ---------- базовая математика ----------
  function mulberry32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function sq(x) { return x * x; }
  function s2l(c) { return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

  // value-noise 2D (для «мятой» бумаги)
  function hash2(ix, iy, seed) {
    var h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
    var c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  }

  // =====================================================================
  //  Построение букета (без рендерера) → { group, wrapGroup, stems, tris, dispose }
  // =====================================================================
  function createBouquet(THREE) {
    var V3 = THREE.Vector3, M4 = THREE.Matrix4, Q = THREE.Quaternion, Color = THREE.Color;
    var rng = mulberry32(73129);
    function rnd(a, b) { return a + (b - a) * rng(); }
    var UP = new V3(0, 1, 0);
    var IDENT = new M4();

    // ---------- палитра (значения в sRGB, в линейное переводим при записи в буферы) ----------
    var PEACH = new Color(0xF2B48E), APRICOT = new Color(0xEE9A64), ORANGE = new Color(0xE2702A);
    var EU_PEACH = new Color(0xF5C3A3), EU_CREAM = new Color(0xF1E6D4);
    var ERY_LO = new Color(0x4E70A6), ERY_HI = new Color(0x7F9DCC);
    var RUSCUS = new Color(0x2F4F35);
    var TWINE = new Color(0xB89B72), PAPER = new Color(0xEFE6D6);
    var RIB_BLUE = new Color(0x8FB3DB), RIB_ORANGE = new Color(0xE98A45);
    var ROSE_STEM = new Color(0x5E7C48), ROSE_LEAF = new Color(0x4C6B3E), SEPAL = new Color(0x66854F);
    var EU_STEM = new Color(0x7E9B74), EU_LEAF = new Color(0x86A083);
    var ERY_STEM = new Color(0x6C8A86), ERY_STEEL = new Color(0x5B7DAE), ERY_BRACT = new Color(0x6E8FC0);
    var RUSCUS_STEM = new Color(0x40623C);

    function tweak(c, dh, ds, dl) { var o = c.clone(); o.offsetHSL(dh, ds, dl); return o; }
    function jit(c, k) { return tweak(c, rnd(-0.008, 0.008) * k, rnd(-0.04, 0.04) * k, rnd(-0.03, 0.03) * k); }
    function linColor(c, k) { k = k === undefined ? 1 : k; return new Color(s2l(c.r) * k, s2l(c.g) * k, s2l(c.b) * k); }

    // ---------- купол, по которому расставлены головки ----------
    var DOME = { cx: 0, cy: 0.95, cz: 0.05, rx: 0.92, ry: 0.95, maxTh: 84 * DEG };
    var DC = new V3(DOME.cx, DOME.cy, DOME.cz);
    function domeAt(thDeg, phDeg) {
      var th = thDeg * DEG, ph = phDeg * DEG;
      return new V3(DOME.cx + Math.sin(th) * Math.sin(ph) * DOME.rx,
        DOME.cy + Math.cos(th) * DOME.ry,
        DOME.cz + Math.sin(th) * Math.cos(ph) * DOME.rx);
    }
    function projectDome(p) {
      var dx = p.x - DOME.cx, dy = p.y - DOME.cy, dz = p.z - DOME.cz;
      var k = 1 / Math.sqrt(sq(dx / DOME.rx) + sq(dy / DOME.ry) + sq(dz / DOME.rx) || 1);
      dx *= k; dy *= k; dz *= k;
      var cosMax = Math.cos(DOME.maxTh);
      if (dy / DOME.ry < cosMax) {
        var h = Math.sqrt(dx * dx + dz * dz) || 1e-6, sinMax = Math.sin(DOME.maxTh);
        dx = dx / h * sinMax * DOME.rx; dz = dz / h * sinMax * DOME.rx; dy = cosMax * DOME.ry;
      }
      p.set(DOME.cx + dx, DOME.cy + dy, DOME.cz + dz);
    }
    // псевдо-AO: зелень в глубине купола темнее
    function domeShade(x, y, z) {
      if (y < 0.12) return 1;
      var e = Math.sqrt(sq((x - DOME.cx) / DOME.rx) + sq((y - DOME.cy) / DOME.ry) + sq((z - DOME.cz) / DOME.rx));
      var k = lerp(0.42, 1, smooth(0.45, 1.0, e));
      return lerp(1, k, smooth(0.12, 0.45, y));
    }

    // ---------- сборщик геометрии (позиции + цвета вершин + индексы) ----------
    function Builder() { this.pos = []; this.col = []; this.idx = []; this.n = 0; this.m = IDENT; }
    var _tv = new V3();
    Builder.prototype.vert = function (p, c) {
      _tv.copy(p).applyMatrix4(this.m);
      this.pos.push(_tv.x, _tv.y, _tv.z);
      this.col.push(c.r, c.g, c.b);
      return this.n++;
    };
    Builder.prototype.quads = function (base, nu, nv, wrapU) {
      var row = wrapU ? nu : nu + 1, i, j, a, b, c, d;
      for (j = 0; j < nv; j++) {
        for (i = 0; i < nu; i++) {
          a = base + j * row + i;
          b = base + j * row + (wrapU ? (i + 1) % nu : i + 1);
          c = a + row; d = b + row;
          this.idx.push(a, b, d, a, d, c);
        }
      }
    };
    // параметрическая сетка: fn(u, v, P, C), u,v ∈ [0..1]
    Builder.prototype.grid = function (nu, nv, fn, wrapU) {
      var base = this.n, P = new V3(), C = new Color(), cols = wrapU ? nu : nu + 1, i, j;
      for (j = 0; j <= nv; j++) {
        for (i = 0; i < cols; i++) { fn(i / nu, j / nv, P, C); this.vert(P, C); }
      }
      this.quads(base, nu, nv, wrapU);
    };
    Builder.prototype.build = function (shadeFn) {
      var g = new THREE.BufferGeometry(), n = this.n, col = new Float32Array(n * 3), i, k;
      for (i = 0; i < n; i++) {
        k = shadeFn ? shadeFn(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]) : 1;
        col[i * 3] = s2l(clamp(this.col[i * 3], 0, 1)) * k;
        col[i * 3 + 1] = s2l(clamp(this.col[i * 3 + 1], 0, 1)) * k;
        col[i * 3 + 2] = s2l(clamp(this.col[i * 3 + 2], 0, 1)) * k;
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(this.idx);
      g.computeVertexNormals();
      return g;
    };

    // ---------- матрицы ----------
    function headMatrix(pos, dir, roll, s) {
      var q = new Q().setFromUnitVectors(UP, dir);
      q.multiply(new Q().setFromAxisAngle(UP, roll));
      return new M4().compose(pos, q, new V3(s, s, s));
    }
    // локальная Z → zDir, локальная Y ≈ yHint
    function basisMatrix(pos, zDir, yHint, s) {
      var z = zDir.clone().normalize();
      var x = new V3().crossVectors(yHint, z);
      if (x.lengthSq() < 1e-6) x.crossVectors(new V3(1, 0, 0), z);
      if (x.lengthSq() < 1e-6) x.crossVectors(new V3(0, 0, 1), z);
      x.normalize();
      var y = new V3().crossVectors(z, x);
      var m = new M4().makeBasis(x, y, z);
      m.scale(new V3(s, s, s));
      m.setPosition(pos);
      return m;
    }
    // parent · RotY(ry) · T(tx,ty,tz)
    function child(parent, ry, tx, ty, tz) {
      var m = new M4().makeRotationY(ry);
      m.multiply(new M4().makeTranslation(tx, ty, tz));
      return new M4().multiplyMatrices(parent, m);
    }

    // ---------- примитивы ----------
    // трубка вдоль кривой (стебли, шпагат); colorFn(t, angle, C)
    function addTube(b, curve, segs, radial, r0, r1, colorFn, cap0, cap1) {
      var base = b.n, P = new V3(), C = new Color(), T = new V3(), N = new V3(1, 0, 0), Bn = new V3(), c = new V3();
      var i, j, t, a, r, ctr;
      for (j = 0; j <= segs; j++) {
        t = j / segs;
        curve.getPoint(t, c);
        curve.getTangent(t, T);
        if (j === 0 && Math.abs(T.x) > 0.9) N.set(0, 0, 1);
        N.addScaledVector(T, -N.dot(T));
        if (N.lengthSq() < 1e-8) { N.set(0, 1, 0).addScaledVector(T, -T.y); }
        N.normalize();
        Bn.crossVectors(T, N);
        r = lerp(r0, r1, t);
        for (i = 0; i < radial; i++) {
          a = i / radial * TAU;
          P.copy(c).addScaledVector(N, Math.cos(a) * r).addScaledVector(Bn, Math.sin(a) * r);
          colorFn(t, a, C);
          b.vert(P, C);
        }
      }
      b.quads(base, radial, segs, true);
      if (cap0) {
        curve.getPoint(0, c); colorFn(0, 0, C); C.multiplyScalar(1.12);
        ctr = b.vert(c, C);
        for (i = 0; i < radial; i++) b.idx.push(ctr, base + (i + 1) % radial, base + i);
      }
      if (cap1) {
        curve.getPoint(1, c); colorFn(1, 0, C);
        ctr = b.vert(c, C);
        var last = base + segs * radial;
        for (i = 0; i < radial; i++) b.idx.push(ctr, last + i, last + (i + 1) % radial);
      }
    }

    function addEllipsoid(b, cx, cy, cz, rx, ry, rz, color, nu, nv) {
      b.grid(nu || 7, nv || 5, function (u, v, P, C) {
        var a = u * TAU, p = v * Math.PI;
        P.set(cx + Math.cos(a) * Math.sin(p) * rx, cy - Math.cos(p) * ry, cz + Math.sin(a) * Math.sin(p) * rz);
        C.copy(color);
      }, true);
    }

    // ланцетный контур: полуширина W, максимум на доле peak длины
    function lance(W, peak) {
      var k = Math.log(0.5) / Math.log(peak);
      return function (t) { return W * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(t, k))), 0.85); };
    }
    // лист/лопасть: начало в (0,0,0), длина вдоль +Z, ширина по X, нормаль +Y;
    // bend0→bend1 — угол касательной к оси Z (изгиб дугой), fold — складка по жилке
    function addBlade(b, o) {
      var L = o.L, d = o.bend1 - o.bend0;
      b.grid(o.nu, o.nv, function (uu, t, P, C) {
        var s = uu * 2 - 1, al = o.bend0 + d * t, z, y;
        if (Math.abs(d) < 1e-4) { z = L * t * Math.cos(o.bend0); y = L * t * Math.sin(o.bend0); }
        else { z = L / d * (Math.sin(al) - Math.sin(o.bend0)); y = -L / d * (Math.cos(al) - Math.cos(o.bend0)); }
        var w = o.width(t);
        var f = (o.fold || 0) * Math.abs(s) * w + (o.wave || 0) * Math.sin(t * 11 + s * 2.5) * w * Math.abs(s);
        P.set(s * w, y + Math.cos(al) * f, z - Math.sin(al) * f);
        o.color(s, t, C);
      });
    }
    function leafColor(c, rib) {
      var light = tweak(c, 0.01, -0.02, rib === undefined ? 0.07 : rib), dark = tweak(c, 0, 0, -0.035);
      return function (s, t, C) {
        C.copy(c).lerp(light, Math.pow(1 - Math.abs(s), 5) * 0.8).lerp(dark, Math.abs(s) * 0.5 + (1 - smooth(0, 0.25, t)) * 0.4);
      };
    }

    // лепесток на поверхности вращения: prof(v, out{r,y}); u — поперёк, v — от основания к краю
    function addPetal(b, o) {
      var pr = { r: 0, y: 0 };
      b.grid(o.nu, o.nv, function (uu, vv, P, C) {
        var u0 = uu * 2 - 1, rk = o.round || 0;
        // квадрат (u,v) → скруглённый контур: углы лепестка превращаются в дугу
        var u = u0 * Math.sqrt(1 - rk * vv * vv / 2);
        var v = vv * Math.sqrt(1 - rk * u0 * u0 / 2);
        o.prof(v, pr);
        var wid = o.W * 0.5 * (o.baseW + (1 - o.baseW) * Math.sin(Math.min(1, v * 1.35) * Math.PI / 2));
        var ang = o.a0 + u * wid + (o.twist || 0) * v;
        var r = pr.r * (1 + o.spiral * u), y = pr.y;
        if (o.ruf) {
          var e = v * v;
          var rf = o.ruf * e * (Math.sin(u * o.rufF + o.ph) + 0.45 * e * Math.sin(u * o.rufF * 2.3 + o.ph * 1.7));
          r += rf * 0.8; y += rf * 0.7;
        }
        if (o.sideCurl) { var sc = o.sideCurl * u0 * u0 * smooth(0.4, 1, vv); r += sc; y -= sc * 0.7; }
        P.set(Math.cos(ang) * r, y, Math.sin(ang) * r);
        o.color(u, v, C);
      });
    }

    // =====================================================================
    //  РОЗА (кустовая): слои чашевидных лепестков по спирали
    // =====================================================================
    function cupProf(rb, rt, h, pw, curl) {
      return function (v, o) {
        var psi = v * Math.PI / 2, k = smooth(0.55, 1, v);
        o.r = rb + (rt - rb) * Math.pow(Math.sin(psi), pw) + curl * k * k;
        o.y = h * (0.35 * v + 0.65 * (1 - Math.cos(psi))) - curl * 0.6 * k * k * k;
      };
    }
    function rosePetalColor(pc, pale, warm, f) {
      return function (u, v, C) {
        C.copy(pc);
        C.lerp(warm, (1 - smooth(0, 0.4, v)) * 0.3);
        C.lerp(pale, smooth(0.72, 1, v) * 0.32 + Math.abs(u) * 0.06);
        C.multiplyScalar((0.48 + 0.52 * smooth(0, 0.6, v)) * lerp(0.8, 1, f) * (1 - 0.16 * smooth(-0.2, -1, u)));
      };
    }
    // [кол-во, r основания, r края, высота, угловая ширина°, отгиб, nu, спираль]
    var ROSE_LAYERS = [
      [3, 0.010, 0.026, 0.200, 250, 0.000, 12, 0.22],
      [3, 0.016, 0.050, 0.222, 205, 0.000, 12, 0.13],
      [4, 0.024, 0.080, 0.236, 160, 0.006, 10, 0.08],
      [5, 0.032, 0.112, 0.240, 128, 0.020, 8, 0.06],
      [5, 0.040, 0.142, 0.226, 116, 0.040, 8, 0.05],
      [5, 0.046, 0.168, 0.200, 108, 0.062, 8, 0.05]
    ];
    function addRose(bp, bg, M, base, open) {
      var nL = open < 0.7 ? 5 : 6, li, k;
      var deep = tweak(base, -0.014, 0.07, -0.11), pale = tweak(base, 0.01, -0.07, 0.055), warm = tweak(base, 0.03, 0.02, 0.04);
      var a = rnd(0, TAU);
      bp.m = M;
      for (li = 0; li < nL; li++) {
        var Lr = ROSE_LAYERS[li], cnt = Lr[0], f = li / 5;
        var loosen = li >= 3 ? lerp(0.8, 1.0, open) : lerp(0.92, 1.0, open);
        for (k = 0; k < cnt; k++) {
          var pc = jit(deep.clone().lerp(base, smooth(0, 0.55, f)).lerp(pale, smooth(0.6, 1, f) * 0.55), 1);
          if (li === nL - 1) pc.lerp(new Color(0xCFCB97), 0.07);        // наружные «рубашки» чуть зеленее
          addPetal(bp, {
            nu: Lr[6], nv: 8,
            a0: a + k * TAU / cnt + rnd(-0.12, 0.12),
            W: Lr[4] * DEG * rnd(0.94, 1.06), baseW: 0.45, round: li < 2 ? 0.45 : 0.8, spiral: Lr[7],
            sideCurl: li >= 3 ? (0.012 + 0.012 * (li - 3)) * open : 0,
            prof: cupProf(Lr[1], Lr[2] * loosen * rnd(0.96, 1.04), Lr[3] * rnd(0.97, 1.03), 0.85, Lr[5] * open * rnd(0.7, 1.3)),
            ruf: li >= 3 ? 0.007 : 0.003, rufF: 4.2, ph: rnd(0, 6),
            color: rosePetalColor(pc, pale, warm, f)
          });
        }
        a += TAU / cnt * 0.5 + 0.35;
      }
      // донце, чтобы снизу не просвечивало
      var bottom = tweak(deep, 0, 0, -0.14);
      bp.grid(8, 1, function (u, v, P, C) {
        var an = u * TAU, r = 0.004 + 0.056 * v;
        P.set(Math.cos(an) * r, 0.012 - 0.008 * v, Math.sin(an) * r); C.copy(bottom);
      }, true);
      bp.m = IDENT;
      // чашелистики и цветоложе
      var sep = jit(SEPAL, 1), sepFn = leafColor(sep, 0.04);
      bg.m = M;
      addEllipsoid(bg, 0, -0.03, 0, 0.03, 0.032, 0.03, tweak(sep, 0, 0, -0.03), 7, 4);
      for (k = 0; k < 5; k++) {
        bg.m = child(M, k * TAU / 5 + rnd(-0.15, 0.15), 0, -0.008, 0.024);
        addBlade(bg, {
          L: 0.15 * rnd(0.9, 1.1), nu: 2, nv: 6, bend0: 0.4, bend1: -0.3 - 1.2 * open * rnd(0.7, 1.1), fold: -0.2,
          width: function (t) { return 0.024 * Math.pow(1 - t, 0.7) * Math.min(1, 0.55 + 2.5 * t); },
          color: sepFn
        });
      }
      bg.m = IDENT;
    }
    function addRoseBud(bp, bg, M, base) {
      var k, deep = tweak(base, -0.012, 0.06, -0.07), pale = tweak(base, 0.008, -0.04, 0.03);
      var R = 0.05, h = 0.17;
      function egg(v, o) { o.r = R * Math.pow(Math.sin(Math.PI * (0.1 + 0.85 * v)), 0.8); o.y = h * v; }
      bp.m = M;
      var a = rnd(0, TAU);
      for (k = 0; k < 4; k++) {
        var pc = jit(deep, 1);
        addPetal(bp, {
          nu: 7, nv: 7, a0: a + k * TAU / 4, W: 230 * DEG, baseW: 0.6, round: 0.4, spiral: 0.14, twist: 0.5,
          prof: egg, ruf: 0, rufF: 0, ph: 0,
          color: (function (c) { return function (u, v, C) { C.copy(c).lerp(pale, smooth(0.6, 1, v) * 0.35).multiplyScalar(0.8 + 0.2 * smooth(0, 0.5, v)); }; })(pc)
        });
      }
      bp.m = IDENT;
      var sep = jit(SEPAL, 1), sepFn = leafColor(sep, 0.04);
      bg.m = M;
      addEllipsoid(bg, 0, -0.026, 0, 0.026, 0.03, 0.026, tweak(sep, 0, 0, -0.03), 7, 4);
      for (k = 0; k < 5; k++) {
        bg.m = child(M, k * TAU / 5 + rnd(-0.1, 0.1), 0, -0.004, 0.02);
        addBlade(bg, {
          L: 0.15 * rnd(0.9, 1.1), nu: 2, nv: 6, bend0: 1.0, bend1: 1.72, fold: -0.25,
          width: function (t) { return 0.021 * Math.pow(1 - t, 0.7) * Math.min(1, 0.6 + 2.5 * t); },
          color: sepFn
        });
      }
      bg.m = IDENT;
    }
    // сложный лист розы: черешок + 3 листочка
    function addRoseLeaf(b, p, dir, c) {
      var fn = leafColor(c, 0.06), pet = tweak(c, 0, 0, 0.03);
      var side = new V3().crossVectors(UP, dir);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      var pe = p.clone().addScaledVector(dir, 0.13);
      addTube(b, new THREE.LineCurve3(p.clone(), pe), 2, 4, 0.006, 0.004, function (t, a, C) { C.copy(pet); }, false, false);
      b.m = basisMatrix(pe, dir, UP, 1);
      addBlade(b, { L: 0.21, nu: 4, nv: 8, width: lance(0.052, 0.42), bend0: 0.12, bend1: -0.55, fold: 0.22, wave: 0.05, color: fn });
      var sg, d2, st;
      for (sg = -1; sg <= 1; sg += 2) {
        d2 = dir.clone().multiplyScalar(Math.cos(0.95)).addScaledVector(side, sg * Math.sin(0.95));
        st = p.clone().addScaledVector(dir, 0.075);
        b.m = basisMatrix(st, d2, UP, 1);
        addBlade(b, { L: 0.16, nu: 4, nv: 7, width: lance(0.042, 0.42), bend0: 0.1, bend1: -0.5, fold: 0.22, wave: 0.05, color: fn });
      }
      b.m = IDENT;
    }

    // =====================================================================
    //  ЭУСТОМА: чаша из 5 широких волнистых лепестков + внутренний круг
    // =====================================================================
    function bellProf(rb, rt, h, flare) {
      return function (v, o) {
        var k = smooth(0.5, 1, v);
        o.r = rb + (rt - rb) * Math.pow(v, 1.25) + flare * k * k;
        o.y = h * (1 - Math.pow(1 - v, 1.5)) - flare * 0.35 * k * k * k;
      };
    }
    function eustomaPetalColor(pc, throat, rim) {
      return function (u, v, C) {
        C.copy(pc).lerp(throat, 1 - smooth(0.05, 0.42, v)).lerp(rim, smooth(0.8, 1, v) * 0.35);
        C.multiplyScalar((0.5 + 0.5 * smooth(0, 0.62, v)) * (1 - 0.14 * Math.pow(Math.abs(u), 3)));
      };
    }
    function addEustoma(bp, bg, M, base) {
      var throat = new Color(0xE2E0B4), rim = tweak(base, -0.012, 0.05, -0.035), k;
      var a = rnd(0, TAU);
      bp.m = M;
      for (k = 0; k < 5; k++) {
        addPetal(bp, {
          nu: 12, nv: 9, a0: a + k * TAU / 5 + rnd(-0.08, 0.08), W: 150 * DEG * rnd(0.95, 1.05),
          baseW: 0.3, round: 0.85, spiral: 0.09,
          prof: bellProf(0.022, 0.19 * rnd(0.95, 1.05), 0.30 * rnd(0.96, 1.04), 0.05 * rnd(0.8, 1.2)),
          ruf: 0.032, rufF: 7.5 * rnd(0.9, 1.1), ph: rnd(0, 6),
          color: eustomaPetalColor(jit(base, 1.6), throat, rim)
        });
      }
      a += 0.6;
      for (k = 0; k < 3; k++) {
        addPetal(bp, {
          nu: 10, nv: 8, a0: a + k * TAU / 3 + rnd(-0.1, 0.1), W: 170 * DEG,
          baseW: 0.3, round: 0.85, spiral: 0.12,
          prof: bellProf(0.018, 0.10 * rnd(0.92, 1.08), 0.27 * rnd(0.95, 1.03), 0.015),
          ruf: 0.018, rufF: 7, ph: rnd(0, 6),
          color: eustomaPetalColor(jit(tweak(base, 0, 0.02, -0.02), 0.8), throat, rim)
        });
      }
      bp.m = IDENT;
      // пестик с двулопастным рыльцем и тычинки
      bg.m = M;
      var pist = new Color(0xB9C36A), stig = new Color(0xD8D46A), anth = new Color(0xE3C55A), fil = new Color(0xDAD9A8);
      addTube(bg, new THREE.LineCurve3(new V3(0, 0.02, 0), new V3(0, 0.15, 0)), 2, 5, 0.012, 0.007,
        function (t, an, C) { C.copy(pist); }, false, false);
      addEllipsoid(bg, 0.012, 0.158, 0, 0.014, 0.011, 0.011, stig, 6, 4);
      addEllipsoid(bg, -0.012, 0.158, 0, 0.014, 0.011, 0.011, stig, 6, 4);
      for (k = 0; k < 5; k++) {
        var sa = a + k * TAU / 5, sx = Math.cos(sa), sz = Math.sin(sa);
        addTube(bg, new THREE.LineCurve3(new V3(sx * 0.012, 0.03, sz * 0.012), new V3(sx * 0.04, 0.115, sz * 0.04)), 1, 4, 0.003, 0.003,
          function (t, an, C) { C.copy(fil); }, false, false);
        addEllipsoid(bg, sx * 0.042, 0.122, sz * 0.042, 0.008, 0.013, 0.008, anth, 5, 3);
      }
      // узкие шиловидные чашелистики
      var sep = jit(EU_STEM, 1), sepFn = leafColor(sep, 0.03);
      addEllipsoid(bg, 0, -0.012, 0, 0.022, 0.024, 0.022, sep, 6, 4);
      for (k = 0; k < 5; k++) {
        bg.m = child(M, k * TAU / 5 + 0.3, 0, -0.005, 0.018);
        addBlade(bg, {
          L: 0.2 * rnd(0.9, 1.1), nu: 2, nv: 5, bend0: 1.15, bend1: 0.75, fold: -0.2,
          width: function (t) { return 0.009 * Math.pow(1 - t, 0.6); }, color: sepFn
        });
      }
      bg.m = IDENT;
    }
    // закрученный бутон эустомы
    function addEustomaBud(bp, bg, M, tint) {
      var k, lo = new Color(0xC6D2A0), hi = new Color(0xECE4C6).lerp(tint, 0.3);
      var R = 0.062, h = 0.3;
      function spindle(v, o) { o.r = 0.004 + R * 2.0 * Math.pow(v, 0.55) * Math.pow(1 - v, 0.75); o.y = h * v; }
      bp.m = M;
      var a = rnd(0, TAU);
      for (k = 0; k < 5; k++) {
        addPetal(bp, {
          nu: 6, nv: 10, a0: a + k * TAU / 5, W: 170 * DEG, baseW: 0.75, round: 0.2, spiral: 0.17, twist: 1.9,
          prof: spindle, ruf: 0, rufF: 0, ph: 0,
          color: (function (j) {
            return function (u, v, C) { C.copy(lo).lerp(hi, smooth(0.15, 0.85, v)).multiplyScalar(j * (0.9 + 0.1 * u)); };
          })(rnd(0.93, 1.0))
        });
      }
      bp.m = IDENT;
      var sep = jit(EU_STEM, 1), sepFn = leafColor(sep, 0.03);
      bg.m = M;
      addEllipsoid(bg, 0, -0.008, 0, 0.018, 0.02, 0.018, sep, 6, 4);
      for (k = 0; k < 5; k++) {
        bg.m = child(M, k * TAU / 5, 0, -0.004, 0.014);
        addBlade(bg, {
          L: 0.15 * rnd(0.9, 1.1), nu: 2, nv: 5, bend0: 1.15, bend1: 1.4, fold: -0.2,
          width: function (t) { return 0.007 * Math.pow(1 - t, 0.6); }, color: sepFn
        });
      }
      bg.m = IDENT;
    }

    // =====================================================================
    //  ЭРИНГИУМ: овальная шишка из бугорков + звезда колючих прицветников
    // =====================================================================
    var ERY_H = 0.2, ERY_R = 0.085;
    function eryR(v) { v = clamp(v, 0, 1); return ERY_R * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(v, 0.72))), 0.75); }
    var eryCdf = (function () {
      var n = 48, acc = [0], s = 0, i;
      for (i = 0; i < n; i++) { s += eryR((i + 0.5) / n); acc.push(s); }
      for (i = 0; i <= n; i++) acc[i] /= s;
      return acc;
    })();
    function eryInv(q) {
      var n = eryCdf.length - 1, i = 0;
      while (i < n - 1 && eryCdf[i + 1] < q) i++;
      var a = eryCdf[i], b = eryCdf[i + 1];
      return (i + (b > a ? (q - a) / (b - a) : 0)) / n;
    }
    // единичный прицветник (длина 1 вдоль +Z) с двумя парами боковых шипов
    var BR_T = [0, 0.1, 0.22, 0.29, 0.36, 0.5, 0.57, 0.64, 0.82, 1];
    var BR_W = [0.45, 0.9, 0.8, 2.2, 0.75, 0.62, 1.7, 0.5, 0.3, 0];
    function makeBractGeometry() {
      var b = new Builder(), W0 = 0.062;
      b.grid(2, 9, function (uu, vv, P, C) {
        var k = Math.round(vv * 9), t = BR_T[k], w = BR_W[k] * W0, s = uu * 2 - 1;
        P.set(s * w, 0.10 * t - 0.16 * t * t + (1 - Math.abs(s)) * 0.02 * (1 - t), t);
        var g = 0.8 + 0.2 * t; C.setRGB(g, g, g);
      });
      return b.build();
    }
    function makeFloretGeometry() {
      var g = new THREE.ConeGeometry(0.0175, 0.036, 5, 1, true);
      g.translate(0, 0.009, 0);
      var pos = g.attributes.position, col = new Float32Array(pos.count * 3), i, k;
      for (i = 0; i < pos.count; i++) { k = pos.getY(i) > 0.01 ? 1.0 : 0.62; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    }
    function makeRuscusLeafGeometry() {
      var b = new Builder();
      addBlade(b, {
        L: 1, nu: 4, nv: 9, width: lance(0.15, 0.36), bend0: 0.16, bend1: -0.42, fold: 0.12,
        color: function (s, t, C) { var g = 0.84 + 0.16 * Math.pow(1 - Math.abs(s), 4) - 0.12 * (1 - smooth(0, 0.2, t)); C.setRGB(g, g, g); }
      });
      return b.build();
    }
    // одна головка: сердцевина → bg, бугорки и прицветники → списки инстансов
    function addEryngiumHead(bg, M, florets, bracts, nFlorets) {
      var i, k, core = tweak(ERY_LO, 0, -0.03, -0.09), coreTop = tweak(ERY_LO, 0, 0, -0.02);
      bg.m = M;
      bg.grid(8, 7, function (u, v, P, C) {
        var a = u * TAU, r = eryR(v) * 0.94;
        P.set(Math.cos(a) * r, 0.01 + ERY_H * v, Math.sin(a) * r);
        C.copy(core).lerp(coreTop, v);
      }, true);
      bg.m = IDENT;
      var ph = rnd(0, TAU), pos = new V3(), nrm = new V3(), q = new Q(), sc = new V3(), loc = new M4();
      for (i = 0; i < nFlorets; i++) {
        var v = clamp(eryInv((i + 0.5) / nFlorets), 0.04, 0.975), a = ph + i * 2.39996;
        var r = eryR(v), dr = (eryR(v + 0.012) - eryR(v - 0.012)) / 0.024, nl = Math.sqrt(ERY_H * ERY_H + dr * dr);
        var nr = ERY_H / nl, ny = -dr / nl + 0.12;
        pos.set(Math.cos(a) * r, 0.01 + ERY_H * v, Math.sin(a) * r);
        nrm.set(Math.cos(a) * nr, ny, Math.sin(a) * nr).normalize();
        q.setFromUnitVectors(UP, nrm);
        var fs = rnd(0.85, 1.15) * (1 - 0.3 * v);
        sc.set(fs, fs * rnd(0.9, 1.25), fs);
        loc.compose(pos, q, sc);
        florets.push({ m: new M4().multiplyMatrices(M, loc), c: jit(ERY_LO.clone().lerp(ERY_HI, smooth(0.05, 0.95, v)), 1) });
      }
      var nb = 9, a0 = rnd(0, TAU), dir = new V3();
      for (k = 0; k < nb; k++) {
        var ba = a0 + k * TAU / nb + rnd(-0.12, 0.12), el = rnd(0.16, 0.48);
        dir.set(Math.sin(ba) * Math.cos(el), Math.sin(el), Math.cos(ba) * Math.cos(el));
        pos.set(dir.x * 0.02, 0.012, dir.z * 0.02);
        loc.copy(basisMatrix(pos, dir, UP, rnd(0.2, 0.275)));
        bracts.push({ m: new M4().multiplyMatrices(M, loc), c: jit(ERY_BRACT.clone().lerp(ERY_HI, rnd(0, 0.5)), 1.2) });
      }
    }

    // =====================================================================
    //  РАСКЛАДКА головок по куполу (сид → стабильна между перезагрузками)
    // =====================================================================
    var stems = [], items = [];
    function tangentBasis(n) {
      var t1 = new V3().crossVectors(UP, n);
      if (t1.lengthSq() < 1e-5) t1.set(1, 0, 0);
      t1.normalize();
      return [t1, new V3().crossVectors(n, t1).normalize()];
    }
    function newStem(kind, th, ph, reach) {
      var st = { kind: kind, items: [], anchor: domeAt(th, ph), reach: reach, ph: ph };
      stems.push(st);
      return st;
    }
    function scatter(st, k, m, rad, a0) {
      var n = st.anchor.clone().sub(DC).normalize(), tb = tangentBasis(n), a = a0 + k * TAU / m;
      return st.anchor.clone().addScaledVector(tb[0], Math.cos(a) * rad).addScaledVector(tb[1], Math.sin(a) * rad);
    }
    function addItem(st, o) { o.stem = st; items.push(o); if (st) st.items.push(o); return o; }

    // розы — основная масса, чуть левее центра и спереди; ровно две ярко-оранжевые головки
    [
      { th: 16, ph: -35, heads: [[PEACH, 1.0, 0.95], [APRICOT, 0.93, 0.85], [PEACH, 0.86, 0.66]], buds: 1 },
      { th: 50, ph: 58, heads: [[APRICOT, 1.0, 0.95], [ORANGE, 0.95, 0.85], [PEACH, 0.86, 0.68]], buds: 1 },
      { th: 57, ph: -50, heads: [[PEACH, 1.0, 0.9], [ORANGE, 0.9, 0.8]], buds: 2 },
      { th: 47, ph: 172, heads: [[APRICOT, 0.98, 0.9], [PEACH, 0.9, 0.75]], buds: 1 }
    ].forEach(function (sp) {
      var st = newStem('rose', sp.th, sp.ph, 0.4), m = sp.heads.length + sp.buds, a0 = rnd(0, TAU), k = 0, i;
      sp.heads.forEach(function (h) {
        var s = h[1] * 1.15;
        addItem(st, { kind: 'rose', p: scatter(st, k++, m, 0.23, a0), r: 0.2 * s * (0.86 + 0.14 * h[2]), lift: rnd(-0.03, 0.03), color: h[0], s: s, open: h[2], off: 0.12 });
      });
      for (i = 0; i < sp.buds; i++) {
        addItem(st, { kind: 'roseBud', p: scatter(st, k++, m, 0.23, a0), r: 0.075, lift: rnd(0.03, 0.09), color: i % 2 ? APRICOT : PEACH, s: rnd(0.95, 1.15), off: 0.085 });   // бутоны не оранжевые: ярких головок ровно две
      }
    });
    // эустома — между розами
    [
      { th: 54, ph: 6, color: EU_PEACH, bud: false },
      { th: 56, ph: -128, color: EU_CREAM, bud: true },
      { th: 42, ph: 112, color: EU_PEACH, bud: true }
    ].forEach(function (sp) {
      var st = newStem('eustoma', sp.th, sp.ph, 0.45), a0 = rnd(0, TAU);
      st.color = sp.color;
      addItem(st, { kind: 'eustoma', p: scatter(st, 0, 2, sp.bud ? 0.12 : 0, a0), r: 0.3, lift: rnd(-0.02, 0.02), s: rnd(1.1, 1.2), off: 0.2 });
      if (sp.bud) addItem(st, { kind: 'eustomaBud', p: scatter(st, 1, 2, 0.25, a0), r: 0.07, lift: rnd(0.08, 0.13), s: rnd(1.0, 1.15), off: 0.15 });
    });
    // эрингиум — холодные точки, разбросанные по куполу и приподнятые
    [
      { th: 24, ph: 62, n: 3 }, { th: 62, ph: -92, n: 3 }, { th: 34, ph: -158, n: 3 }, { th: 34, ph: 14, n: 4 }
    ].forEach(function (sp) {
      var st = newStem('eryngium', sp.th, sp.ph, 0.46), a0 = rnd(0, TAU), i;
      addItem(st, { kind: 'eryngium', p: st.anchor.clone(), r: 0.135, lift: rnd(0.12, 0.16), s: 1.1, primary: true, off: 0.088 });
      for (i = 1; i < sp.n; i++) {
        var s = rnd(0.78, 0.92);
        addItem(st, { kind: 'eryngium', p: scatter(st, i, sp.n - 1, 0.32, a0), r: 0.11, lift: rnd(0.04, 0.1), s: s, off: 0.08 * s });
      }
    });
    // рускус — обрамление слева / справа / сзади; «призраки» держат для него просветы у кромки
    [-100, 98, 186].forEach(function (ph) {
      var st = newStem('ruscus', 84, ph, 0);
      items.push({ kind: 'ghost', p: domeAt(84, ph), r: 0.13, fixed: true, stem: null });
      st.ph = ph;
    });

    (function relax() {
      var d = new V3(), c = new V3(), i, j, iter, n = items.length;
      for (i = 0; i < n; i++) projectDome(items[i].p);
      for (iter = 0; iter < 320; iter++) {
        for (i = 0; i < n; i++) {
          for (j = i + 1; j < n; j++) {
            var A = items[i], B = items[j];
            if (A.fixed && B.fixed) continue;
            d.subVectors(B.p, A.p);
            var dist = d.length(), min = (A.r + B.r) * 1.05;
            if (dist < min) {
              if (dist < 1e-5) { d.set(rng() - 0.5, 0, rng() - 0.5); dist = d.length() || 1; }
              var mv = (min - dist) / dist * 0.5;
              var wa = A.fixed ? 0 : (B.fixed ? 1 : 0.5), wb = 1 - wa;
              if (B.fixed) wb = 0;
              A.p.addScaledVector(d, -mv * wa);
              B.p.addScaledVector(d, mv * wb);
            }
          }
        }
        for (i = 0; i < stems.length; i++) {
          var st = stems[i], m = st.items.length;
          if (!m) continue;
          c.set(0, 0, 0);
          for (j = 0; j < m; j++) c.add(st.items[j].p);
          c.multiplyScalar(1 / m);
          for (j = 0; j < m; j++) {
            var it = st.items[j], dd = it.p.distanceTo(c);
            if (dd > st.reach && dd > 1e-6) it.p.lerp(c, (dd - st.reach) / dd * 0.5);
            it.p.addScaledVector(d.subVectors(st.anchor, c), 0.03);     // композиция не «уплывает» от задуманной
          }
        }
        for (i = 0; i < n; i++) if (!items[i].fixed) projectDome(items[i].p);
      }
    })();

    // нормали (куда смотрит головка), итоговые позиции и точки крепления к стеблю
    var FACE = new V3(0, 0.2, -0.1);
    stems.forEach(function (st) {
      var c = new V3(), m = st.items.length;
      st.items.forEach(function (it) { c.add(it.p); });
      if (m) c.multiplyScalar(1 / m);
      st.items.forEach(function (it) {
        var n = it.p.clone().sub(FACE).normalize();
        if (m > 1) n.addScaledVector(it.p.clone().sub(c), 0.6);
        if (it.primary) n.addScaledVector(UP, 0.35);
        n.x += rnd(-0.1, 0.1); n.y += rnd(-0.05, 0.05); n.z += rnd(-0.1, 0.1);
        n.normalize();
        it.n = n;
        it.pos = it.p.clone().addScaledVector(it.p.clone().sub(DC).normalize(), it.lift);
        it.base = it.pos.clone().addScaledVector(n, -it.off * (it.kind === 'eryngium' ? 1 : it.s));
      });
    });

    // ---------- стебли: цель над связкой, слот в связке, срез снизу ----------
    var CUT_Y = -1.0, WAIST_Y = -0.2, WAIST_R = 0.165, BAND_R = 0.2;
    stems.forEach(function (st) {
      var c = new V3();
      if (st.kind === 'ruscus') {
        var ph = st.ph * DEG, bendA = rnd(-0.22, 0.22);
        var way = [[0.42, 0.55, 0], [0.85, 0.9, 0.4], [1.18, 1.07, 0.8], [1.42, 1.05, 1.0]];
        st.way = way.map(function (w) {
          var a = ph + bendA * w[2];
          return new V3(Math.sin(a) * w[0], w[1], Math.cos(a) * w[0] + DOME.cz * 0.5);
        });
        st.aim = st.way[0];
        return;
      }
      st.items.forEach(function (it) { c.add(it.base); });
      c.multiplyScalar(1 / st.items.length);
      if (st.kind === 'eustoma') {
        var bloom = st.items[0];
        st.pre = bloom.base.clone().addScaledVector(bloom.n, -0.3);
        st.aim = st.pre;
      } else {
        st.aim = c.clone().addScaledVector(c.clone().normalize(), st.kind === 'rose' ? -0.42 : -0.4);
      }
    });
    (function assignSlots() {
      var n = stems.length, slots = [], used = [], i, k;
      for (k = 0; k < n; k++) {
        var r = 0.025 * Math.sqrt(k + 0.5), a = k * 2.39996;
        slots.push(new V3(Math.sin(a) * r, 0, Math.cos(a) * r));
      }
      st_loop:
      for (i = 0; i < n; i++) {
        var st = stems[i], az = Math.atan2(st.aim.x, st.aim.z) - 75 * DEG;      // спиральная сборка: все стебли с одним уклоном
        var tx = Math.sin(az) * 0.065, tz = Math.cos(az) * 0.065, best = -1, bd = 1e9;
        for (k = 0; k < n; k++) {
          if (used[k]) continue;
          var dd = sq(slots[k].x - tx) + sq(slots[k].z - tz);
          if (dd < bd) { bd = dd; best = k; }
        }
        if (best < 0) continue st_loop;
        used[best] = true;
        st.B = slots[best];
      }
    })();
    stems.forEach(function (st) {
      var B = st.B, d = st.aim.clone().sub(B);
      var lx = d.x / d.y, lz = d.z / d.y, tw = -0.4, fan = 0.38 * (0 - CUT_Y);
      var ll = Math.sqrt(lx * lx + lz * lz);
      if (ll > 0.8) { lx *= 0.8 / ll; lz *= 0.8 / ll; }
      var ox = -(lx * Math.cos(tw) + lz * Math.sin(tw)) * fan, oz = -(-lx * Math.sin(tw) + lz * Math.cos(tw)) * fan;
      var bx = B.x + ox, bz = B.z + oz;
      var bottom = new V3(bx, CUT_Y + 0.3 * bx + rnd(-0.008, 0.008), bz);     // общий косой срез
      var B2 = new V3(B.x + ox * 0.12, WAIST_Y, B.z + oz * 0.12);
      var mid = new V3(B.x + d.x * 0.5 * 0.86, d.y * 0.5, B.z + d.z * 0.5 * 0.86);
      var pts = [bottom, B2, B.clone(), mid, st.aim.clone()];
      if (st.kind === 'eustoma') pts.push(st.items[0].base.clone());
      if (st.kind === 'ruscus') { pts.pop(); pts.pop(); pts = pts.concat(st.way.map(function (w) { return w.clone(); })); }
      st.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    });

    // листья не должны протыкать головки: проверяем середину и кончик листа
    var solidHeads = items.filter(function (it) { return !!it.pos && it.kind !== 'eryngium'; });
    var _q = new V3();
    function hitsHead(p, pad) {
      for (var i = 0; i < solidHeads.length; i++) {
        if (p.distanceTo(solidHeads[i].pos) < solidHeads[i].r * 1.05 + pad) return true;
      }
      return false;
    }
    function leafFree(p, dir, L) {
      return !hitsHead(_q.copy(p).addScaledVector(dir, L * 0.55), 0.03) && !hitsHead(_q.copy(p).addScaledVector(dir, L), 0.015);
    }

    function tAtY(curve, y) {
      var lo = 0, hi = 1, P = new V3(), k, mid;
      for (k = 0; k < 22; k++) { mid = (lo + hi) / 2; curve.getPoint(mid, P); if (P.y < y) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }
    function stemColor(c0, c1) {
      var j = rnd(0, 6);
      return function (t, a, C) { C.copy(c0).lerp(c1, t).multiplyScalar(0.94 + 0.06 * Math.sin(a + j)); };
    }
    function outward(p, spread) {
      var r = new V3(p.x, 0, p.z);
      if (r.lengthSq() < 1e-4) r.set(rnd(-1, 1), 0, rnd(-1, 1));
      r.normalize().applyAxisAngle(UP, rnd(-spread, spread));
      return r;
    }

    // ---------- материалы ----------
    var matOpt = function (rough, metal) { return { vertexColors: true, roughness: rough, metalness: metal || 0, side: THREE.DoubleSide }; };
    var petalMat = new THREE.MeshStandardMaterial(matOpt(0.8));
    var greenMat = new THREE.MeshStandardMaterial(matOpt(0.62));
    var glossMat = new THREE.MeshStandardMaterial(matOpt(0.3));          // глянцевый рускус
    var eryMat = new THREE.MeshStandardMaterial(matOpt(0.52, 0.12));
    var matteMat = new THREE.MeshStandardMaterial(matOpt(0.96));         // бумага, джут
    var ribbonMat = new THREE.MeshStandardMaterial(matOpt(0.42));
    var materials = [petalMat, greenMat, glossMat, eryMat, matteMat, ribbonMat];

    var bractGeo = makeBractGeometry(), floretGeo = makeFloretGeometry(), ruscusLeafGeo = makeRuscusLeafGeometry();
    var geometries = [bractGeo, floretGeo, ruscusLeafGeo];
    var tris = 0;
    function countTris(g, inst) { tris += (g.index ? g.index.count : g.attributes.position.count) / 3 * (inst || 1); }

    function meshFrom(builder, mat, shade) {
      var g = builder.build(shade);
      geometries.push(g); countTris(g);
      return new THREE.Mesh(g, mat);
    }
    function instanced(geo, mat, list, shade) {
      var mesh = new THREE.InstancedMesh(geo, mat, list.length), i, e = new V3();
      for (i = 0; i < list.length; i++) {
        mesh.setMatrixAt(i, list[i].m);
        e.setFromMatrixPosition(list[i].m);
        mesh.setColorAt(i, linColor(list[i].c, shade ? domeShade(e.x, e.y, e.z) : 1));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;          // bbox базовой геометрии не учитывает инстансы
      countTris(geo, list.length);
      return mesh;
    }

    var root = new THREE.Group();
    var swayList = [];
    var SWAY = { rose: 0.011, eustoma: 0.015, eryngium: 0.017, ruscus: 0.02 };

    // ---------- сборка стеблей ----------
    stems.forEach(function (st) {
      var group = new THREE.Group(), bp = new Builder(), bg = new Builder();
      var florets = [], bracts = [], leaves = [];
      var green, k, t, p, y;

      if (st.kind === 'rose') {
        green = jit(ROSE_STEM, 1.6);
        addTube(bg, st.curve, 26, 6, 0.022, 0.016, stemColor(tweak(green, 0.01, 0, -0.03), green), true, false);
        st.items.forEach(function (it) {
          var isBud = it.kind === 'roseBud';
          var ctrl = it.base.clone().addScaledVector(it.n, -it.base.distanceTo(st.aim) * 0.55);
          addTube(bg, new THREE.QuadraticBezierCurve3(st.aim.clone(), ctrl, it.base.clone()), 8, 5, 0.013, isBud ? 0.007 : 0.011,
            stemColor(green, tweak(green, 0, 0, 0.03)), false, false);
          var M = headMatrix(it.base, it.n, rnd(0, TAU), it.s);
          if (isBud) addRoseBud(bp, bg, M, it.color); else addRose(bp, bg, M, it.color, it.open);
        });
        var lc = jit(ROSE_LEAF, 1.5), ys = [rnd(0.56, 0.66), rnd(0.74, 0.86), rnd(0.94, 1.06)], tries, dir;
        for (k = 0; k < ys.length; k++) {
          y = ys[k];
          if (y > st.aim.y - 0.03) continue;
          t = tAtY(st.curve, y); p = st.curve.getPoint(t);
          for (tries = 0; tries < 6; tries++) {
            dir = outward(p, 1.0).multiplyScalar(Math.cos(0.6)).addScaledVector(UP, Math.sin(0.6));
            if (leafFree(p, dir, 0.34)) { addRoseLeaf(bg, p, dir, jit(lc, 1)); break; }
          }
        }
      }

      if (st.kind === 'eustoma') {
        green = jit(EU_STEM, 1.4);
        addTube(bg, st.curve, 28, 6, 0.018, 0.013, stemColor(tweak(green, 0, 0, -0.03), green), true, false);
        var bloom = st.items[0];
        addEustoma(bp, bg, headMatrix(bloom.base, bloom.n, rnd(0, TAU), bloom.s), st.color);
        st.items.slice(1).forEach(function (it) {
          var from = st.curve.getPoint(0.66);
          var ctrl = it.base.clone().addScaledVector(it.n, -it.base.distanceTo(from) * 0.5);
          addTube(bg, new THREE.QuadraticBezierCurve3(from, ctrl, it.base.clone()), 9, 5, 0.01, 0.007, stemColor(green, green), false, false);
          addEustomaBud(bp, bg, headMatrix(it.base, it.n, rnd(0, TAU), it.s), st.color);
        });
        // супротивные сизо-зелёные листья
        var lfn = leafColor(jit(EU_LEAF, 1.2), 0.05), ts = [0.63, 0.76];
        for (k = 0; k < ts.length; k++) {
          p = st.curve.getPoint(ts[k]);
          var tg = st.curve.getTangent(ts[k]), o1 = outward(p, 1.4), sgn;
          o1.addScaledVector(tg, -o1.dot(tg)).normalize();
          if (k === 1) o1.applyAxisAngle(tg, Math.PI / 2);
          for (sgn = -1; sgn <= 1; sgn += 2) {
            var ld = o1.clone().multiplyScalar(sgn * 0.8).addScaledVector(tg, 0.6).normalize();
            if (!leafFree(p, ld, 0.25)) continue;
            bg.m = basisMatrix(p, ld, tg, 1);
            addBlade(bg, { L: 0.25 * rnd(0.85, 1.1), nu: 4, nv: 7, width: lance(0.055, 0.4), bend0: 0.05, bend1: -0.45, fold: 0.28, color: lfn });
          }
          bg.m = IDENT;
        }
      }

      if (st.kind === 'eryngium') {
        green = jit(ERY_STEM, 1.4);
        var steel = jit(ERY_STEEL, 1);
        addTube(bg, st.curve, 26, 6, 0.019, 0.014, stemColor(tweak(green, 0.02, 0, -0.03), green.clone().lerp(steel, 0.6)), true, false);
        st.items.forEach(function (it) {
          var ctrl = it.base.clone().addScaledVector(it.n, -it.base.distanceTo(st.aim) * 0.55);
          addTube(bg, new THREE.QuadraticBezierCurve3(st.aim.clone(), ctrl, it.base.clone()), 8, 5, 0.012, 0.009,
            stemColor(green.clone().lerp(steel, 0.6), steel), false, false);
          addEryngiumHead(bg, headMatrix(it.base, it.n, rnd(0, TAU), it.s), florets, bracts, it.primary ? 62 : 54);
        });
        // колючие листочки в узле ветвления
        for (k = 0; k < 3; k++) {
          var nd = outward(st.aim, 3.14).multiplyScalar(0.8).addScaledVector(UP, 0.6).normalize();
          bracts.push({ m: basisMatrix(st.aim, nd, UP, rnd(0.24, 0.3)), c: jit(ERY_STEM.clone().lerp(ERY_BRACT, 0.45), 1.2) });
        }
      }

      if (st.kind === 'ruscus') {
        green = jit(RUSCUS_STEM, 1.2);
        addTube(bg, st.curve, 34, 5, 0.014, 0.004, stemColor(tweak(green, 0, 0, -0.02), green), true, false);
        var t0 = tAtY(st.curve, 0.5), nL = 21, T = new V3(), R = new V3(), S = new V3(), side = 1;
        var addLeaf = function (pp, tan, sd, L) {
          R.set(pp.x, 0, pp.z).normalize();
          S.crossVectors(tan, R).normalize();
          var ld = tan.clone().multiplyScalar(0.62).addScaledVector(S, sd * 0.74).addScaledVector(R, rnd(-0.12, 0.25)).normalize();
          var hint = R.clone().addScaledVector(UP, 0.35); hint.x += rnd(-0.25, 0.25); hint.z += rnd(-0.25, 0.25);
          if (!leafFree(pp, ld, L)) { L *= 0.6; if (!leafFree(pp, ld, L)) return; }
          leaves.push({ m: basisMatrix(pp, ld, hint, L), c: tweak(RUSCUS, rnd(-0.012, 0.012), rnd(-0.05, 0.05), rnd(-0.03, 0.04)) });
        };
        for (k = 0; k < nL; k++) {
          t = lerp(t0, 0.985, Math.pow(k / (nL - 1), 0.9));
          p = st.curve.getPoint(t); st.curve.getTangent(t, T);
          addLeaf(p, T, side, lerp(0.4, 0.25, k / (nL - 1)) * rnd(0.9, 1.1));
          side = -side;
        }
        // верхушечный лист
        p = st.curve.getPoint(1); st.curve.getTangent(1, T);
        leaves.push({ m: basisMatrix(p, T, new V3(p.x, 0.6, p.z), 0.26), c: tweak(RUSCUS, 0.01, 0, 0.04) });
        // боковая веточка
        var tb = lerp(t0, 1, 0.3), p0 = st.curve.getPoint(tb), sd0 = rng() < 0.5 ? -1 : 1;
        st.curve.getTangent(tb, T);
        R.set(p0.x, 0, p0.z).normalize(); S.crossVectors(T, R).normalize();
        var bd = T.clone().multiplyScalar(0.55).addScaledVector(S, sd0 * 0.75).addScaledVector(UP, 0.25).normalize();
        var bc = new THREE.QuadraticBezierCurve3(p0.clone(), p0.clone().addScaledVector(bd, 0.28).addScaledVector(UP, 0.05),
          p0.clone().addScaledVector(bd, 0.56).addScaledVector(UP, -0.02));
        addTube(bg, bc, 8, 4, 0.008, 0.003, stemColor(green, green), false, false);
        side = 1;
        for (k = 0; k < 8; k++) {
          t = lerp(0.18, 0.97, k / 7);
          p = bc.getPoint(t); bc.getTangent(t, T);
          addLeaf(p, T, side, lerp(0.32, 0.22, k / 7) * rnd(0.9, 1.1));
          side = -side;
        }
      }

      if (bp.n) group.add(meshFrom(bp, petalMat));
      if (bg.n) group.add(meshFrom(bg, greenMat, domeShade));
      if (florets.length) group.add(instanced(floretGeo, eryMat, florets, false));
      if (bracts.length) group.add(instanced(bractGeo, eryMat, bracts, false));
      if (leaves.length) group.add(instanced(ruscusLeafGeo, glossMat, leaves, true));
      root.add(group);
      swayList.push({
        group: group, amp: SWAY[st.kind] * rnd(0.8, 1.2),
        w1: rnd(0.55, 0.95), w2: rnd(0.45, 0.85), p1: rnd(0, TAU), p2: rnd(0, TAU)
      });
    });

    // ---------- джутовый шпагат на связке ----------
    (function buildTwine() {
      var b = new Builder(), maxR = 0, i;
      stems.forEach(function (st) { maxR = Math.max(maxR, Math.sqrt(st.B.x * st.B.x + st.B.z * st.B.z)); });
      var R = maxR + 0.022 + 0.011, turns = 6, n = turns * 26, pts = [];
      for (i = 0; i <= n; i++) {
        var t = i / n, a = t * turns * TAU + 0.45;
        var r = R + 0.004 * Math.sin(a * 2.3 + 1);
        pts.push(new V3(Math.sin(a) * r, lerp(-0.062, 0.062, t) + 0.005 * Math.sin(a * 0.7), Math.cos(a) * r));
      }
      var fibre = function (t, a, C) { C.copy(TWINE).multiplyScalar(0.84 + 0.16 * Math.sin(a * 2 + t * n * 2.1)); };
      addTube(b, new THREE.CatmullRomCurve3(pts), n, 5, 0.0115, 0.0115, fibre, true, true);
      // узелок и два хвостика
      var ka = 0.45, K = new V3(Math.sin(ka) * (R + 0.014), 0.0, Math.cos(ka) * (R + 0.014));
      addEllipsoid(b, K.x, K.y, K.z, 0.022, 0.02, 0.02, tweak(TWINE, 0, 0, -0.04), 7, 5);
      var out = new V3(Math.sin(ka), 0, Math.cos(ka));
      var fib2 = function (t, a, C) { C.copy(TWINE).multiplyScalar(0.84 + 0.16 * Math.sin(a * 2 + t * 30)); };
      addTube(b, new THREE.QuadraticBezierCurve3(K.clone(), K.clone().addScaledVector(out, 0.07).add(new V3(0.03, 0.03, 0)),
        K.clone().addScaledVector(out, 0.08).add(new V3(0.06, -0.12, 0))), 8, 5, 0.0105, 0.009, fib2, false, true);
      addTube(b, new THREE.QuadraticBezierCurve3(K.clone(), K.clone().addScaledVector(out, 0.06).add(new V3(-0.04, 0.02, 0)),
        K.clone().addScaledVector(out, 0.07).add(new V3(-0.07, -0.16, 0.01))), 8, 5, 0.0105, 0.009, fib2, false, true);
      root.add(meshFrom(b, matteMat));
    })();

    // ---------- обёртка: бумажный конус + бант из двух лент ----------
    var wrapGroup = new THREE.Group();
    function rPaper(y) {
      if (y >= WAIST_Y) {
        var s = y - WAIST_Y;
        return WAIST_R + 1.12 * s * s / (s + 0.25) + 0.14 * Math.pow(Math.max(0, y) / 0.95, 3);
      }
      return WAIST_R + 0.42 * Math.pow(WAIST_Y - y, 1.2);
    }
    (function buildPaper() {
      var b = new Builder(), seed = 11, gTop = 58 * DEG;
      b.grid(84, 32, function (uu, vv, P, C) {
        var s = uu * 2 - 1, as = Math.abs(s);
        var yTop = 0.92 - 0.38 * s * s + 0.15 * smooth(0.78, 1, as) + 0.05 * (vnoise(s * 6 + 5, 1.5, seed) - 0.5);
        var yBot = -0.64 + 0.05 * vnoise(s * 5 + 9, 7.5, seed) - 0.04 * s;
        var y = lerp(yBot, yTop, vv);
        // спереди V-образный раскрыв, ниже талии края внахлёст
        var g = y > -0.1 ? gTop * Math.pow((y + 0.1) / 1.02, 0.7) : -0.55 * smooth(-0.1, -0.3, y);
        var A = Math.PI - g, az = Math.PI + s * A;
        var amp = clamp(Math.abs(y - WAIST_Y) * 2.0 + 0.1, 0, 1);
        var n1 = vnoise(s * 7 + 3.3, y * 5 + 1.7, seed), ridge = 1 - Math.abs(2 * n1 - 1);
        var n2 = vnoise(s * 17 + 8.1, y * 13 + 4.2, seed + 1);
        var pleat = Math.sin(s * A * 11 + 1.3) * Math.exp(-sq((y - WAIST_Y - 0.25) * 2.6)) * 0.014 * amp;
        // заломы: |sin| даёт острые складки по диагоналям листа
        var c1 = Math.abs(Math.sin(s * A * 3.1 + y * 2.3 + 0.7)), c2 = Math.abs(Math.sin(s * A * 1.7 - y * 3.9 + 2.1));
        var crease = ((c1 - 0.64) * 0.034 + (c2 - 0.64) * 0.028) * amp;
        var r = rPaper(y) * (1 + 0.035 * s) + (ridge - 0.5) * 0.05 * amp + (n2 - 0.5) * 0.02 * amp + pleat + crease
          + 0.07 * smooth(0.72, 1, as) * smooth(0.35, 1, vv);
        P.set(Math.sin(az) * r, y, Math.cos(az) * r);
        var shade = y > WAIST_Y ? lerp(0.8, 1, smooth(-0.1, 0.8, y)) : lerp(0.86, 0.97, smooth(WAIST_Y, -0.6, y));
        shade *= 0.93 + 0.06 * ridge - 0.03 * n2 + 0.05 * Math.min(c1, c2);
        C.copy(PAPER).multiplyScalar(shade);
      });
      wrapGroup.add(meshFrom(b, matteMat));
    })();
    (function buildBow() {
      var b = new Builder();
      var K = new V3(0, WAIST_Y, BAND_R + 0.045);
      function ribbonCol(c) {
        var j = rnd(0, 6), lo = tweak(c, 0, 0.02, -0.05);
        return function (uu, v, C) { C.copy(c).lerp(lo, 0.5 + 0.5 * Math.sin(v * 8 + j)).multiplyScalar(0.96 + 0.08 * Math.abs(uu * 2 - 1)); };
      }
      // петля банта: «восьмёрка» в плоскости (в сторону, вперёд), ширина ленты ≈ по вертикали
      function loop(side, tilt, L, D, hw, c, zOff) {
        var ct = Math.cos(tilt), stl = Math.sin(tilt), cf = ribbonCol(c);
        b.grid(2, 22, function (uu, t, P, C) {
          var a = Math.PI * t, sa = Math.sin(a);
          var lx = L * Math.pow(sa, 0.85), ly = -0.03 * sa * sa;
          var lz = D * Math.sin(2 * a); if (lz < 0) lz *= 0.4;
          var w = hw * (0.38 + 0.62 * Math.pow(sa, 0.6)) * (uu * 2 - 1);
          P.set(K.x + side * (lx * ct - (ly + w) * stl), K.y + lx * stl + (ly + w) * ct, K.z + zOff + lz + w * 0.25);
          cf(uu, t, C);
        });
      }
      // хвост ленты: свисает с лёгкой волной и скручиванием, конец — «ласточкин хвост»
      function tail(side, len, spread, hw, c, zOff, ph) {
        var cf = ribbonCol(c);
        b.grid(2, 26, function (uu, vv, P, C) {
          var u = uu * 2 - 1;
          var t = vv * (1 - 0.06 * (1 - Math.abs(u)));
          var x = side * (0.02 + spread * Math.pow(t, 0.85)) + 0.022 * Math.sin(t * 6 + ph) * t;
          var y = -len * Math.pow(t, 1.1);
          var z = zOff + 0.012 + 0.17 * smooth(0, 0.45, t) + 0.03 * Math.sin(t * 7.5 + ph * 1.3) * t;
          var tw = 0.55 * Math.sin(t * 4.2 + ph);
          var w = hw * (0.5 + 0.5 * smooth(0, 0.12, t)) * u;
          P.set(K.x + x + Math.cos(tw) * w, K.y + y + 0.12 * w * side, K.z + z + Math.sin(tw) * w);
          cf(uu, vv, C);
        });
      }
      function band(y0, c) {
        b.grid(36, 1, function (uu, vv, P, C) {
          var a = uu * TAU, r = BAND_R + 0.003 * Math.sin(a * 5);
          P.set(Math.sin(a) * r, y0 + (vv - 0.5) * 0.05, Math.cos(a) * r);
          C.copy(c).multiplyScalar(0.95 + 0.05 * Math.sin(a * 3));
        }, true);
      }
      var HW = 0.055;
      band(WAIST_Y + 0.025, RIB_BLUE); band(WAIST_Y - 0.025, RIB_ORANGE);
      loop(-1, 0.5, 0.36, 0.11, HW, RIB_BLUE, 0); loop(1, 0.42, 0.34, 0.11, HW, RIB_BLUE, 0);
      loop(-1, -0.16, 0.3, 0.09, HW, RIB_ORANGE, 0.02); loop(1, -0.08, 0.32, 0.09, HW, RIB_ORANGE, 0.02);
      tail(-1, 0.84, 0.2, HW, RIB_BLUE, 0, 0.6); tail(1, 0.68, 0.12, HW, RIB_BLUE, 0.008, 2.4);
      tail(-1, 0.6, 0.07, HW, RIB_ORANGE, 0.02, 4.1); tail(1, 0.9, 0.24, HW, RIB_ORANGE, 0.014, 5.3);
      addEllipsoid(b, K.x - 0.01, K.y + 0.008, K.z, 0.045, 0.052, 0.036, tweak(RIB_BLUE, 0, 0, -0.03), 8, 5);
      addEllipsoid(b, K.x + 0.016, K.y - 0.016, K.z + 0.008, 0.04, 0.044, 0.036, tweak(RIB_ORANGE, 0, 0, -0.03), 8, 5);
      wrapGroup.add(meshFrom(b, ribbonMat));
    })();
    root.add(wrapGroup);

    return {
      group: root,
      wrapGroup: wrapGroup,
      stems: swayList,
      tris: Math.round(tris),
      layout: items,
      dispose: function () {
        var i;
        for (i = 0; i < geometries.length; i++) geometries[i].dispose();
        for (i = 0; i < materials.length; i++) materials[i].dispose();
        root.traverse(function (o) { if (o.isInstancedMesh && o.dispose) o.dispose(); });
      }
    };
  }

  // =====================================================================
  //  Публичный API
  // =====================================================================
  function initBouquet3D(container) {
    var inert = { setWrap: function () {}, dispose: function () {} };
    if (!container || typeof document === 'undefined') return inert;

    function fail(text) {
      var el = document.createElement('p');
      el.textContent = text;
      el.style.margin = '0';
      el.style.padding = '1.5em 1em';
      el.style.textAlign = 'center';
      el.style.opacity = '0.75';
      container.appendChild(el);
      return { setWrap: function () {}, dispose: function () { if (el.parentNode) el.parentNode.removeChild(el); } };
    }

    var T3 = window.THREE;
    if (!T3 || !T3.WebGLRenderer) return fail('Не удалось загрузить 3D-букет: библиотека three.js недоступна.');

    var renderer;
    try {
      renderer = new T3.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      return fail('3D-букет недоступен: браузер или устройство не поддерживает WebGL.');
    }

    var bq;
    try {
      bq = createBouquet(T3);
    } catch (e2) {
      try { renderer.dispose(); } catch (e3) { /* нечего освобождать */ }
      if (window.console && console.error) console.error('bouquet3d:', e2);
      return fail('Не удалось построить 3D-букет.');
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = T3.sRGBEncoding;

    var canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Трёхмерная модель букета: кустовые розы, эустома, эрингиум и рускус. Перетащите, чтобы повернуть.');
    container.appendChild(canvas);

    var scene = new T3.Scene();
    var camera = new T3.PerspectiveCamera(30, 1, 0.5, 60);
    // мягкий свет: небо/земля + тёплый ключевой + холодный контровой + слабое заполнение
    scene.add(new T3.HemisphereLight(0xfff6ea, 0xd0c5b8, 0.6));
    var key = new T3.DirectionalLight(0xfff0dc, 0.6); key.position.set(-3, 5, 4.5); scene.add(key);
    var rim = new T3.DirectionalLight(0xd2e1ff, 0.5); rim.position.set(3, 2.5, -5); scene.add(rim);
    var fill = new T3.DirectionalLight(0xffffff, 0.16); fill.position.set(4, 0.5, 3); scene.add(fill);
    var bounce = new T3.DirectionalLight(0xfff1e2, 0.14); bounce.position.set(-0.5, -3, 2); scene.add(bounce);   // отсвет снизу, чтобы изнанка не проваливалась

    var pivot = new T3.Group();
    bq.group.position.set(0, -0.5, 0);       // центр композиции — в начало координат
    bq.group.rotation.x = 0.06;              // букет слегка наклонён «лицом» к зрителю
    pivot.add(bq.group);
    scene.add(pivot);

    var FIT_R = 1.78, TILT_MIN = -0.2, TILT_MAX = 0.75, ZOOM_MIN = 0.75, ZOOM_MAX = 1.9;
    var yaw = -0.25, tilt = 0.2, zoom = 1, vel = 0;
    var interacted = false, dirty = true, visible = true, disposed = false, raf = 0, lastT = 0, time = 0, swayOn = false;
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    function reduced() { return !!(mq && mq.matches); }

    function fit() {
      var half = camera.fov * DEG / 2, hh = Math.atan(Math.tan(half) * camera.aspect);
      var d = FIT_R / Math.sin(Math.min(half, hh)) / zoom;
      camera.position.set(0, 0, d);
      camera.near = Math.max(0.1, d - 4);
      camera.far = d + 6;
      camera.updateProjectionMatrix();
      dirty = true;
    }
    function resize() {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      fit();
    }

    function frame(now) {
      if (disposed) return;
      raf = window.requestAnimationFrame(frame);
      var dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
      lastT = now;
      if (!visible) return;
      var still = reduced(), i, s;
      if (!still) {
        time += dt;
        if (!interacted) { yaw += dt * 0.22; dirty = true; }
        if (!ptrCount && Math.abs(vel) > 0.002) { yaw += vel * dt; vel *= Math.exp(-dt * 3.2); dirty = true; }
        for (i = 0; i < bq.stems.length; i++) {
          s = bq.stems[i];
          s.group.rotation.x = s.amp * Math.sin(time * s.w1 + s.p1);
          s.group.rotation.z = s.amp * Math.sin(time * s.w2 + s.p2);
        }
        swayOn = true; dirty = true;
      } else if (swayOn) {
        for (i = 0; i < bq.stems.length; i++) bq.stems[i].group.rotation.set(0, 0, 0);
        swayOn = false; vel = 0; dirty = true;
      }
      if (dirty) {
        pivot.rotation.set(tilt, yaw, 0);
        renderer.render(scene, camera);
        dirty = false;
      }
    }

    // ---------- управление: pointer events (мышь и касания) ----------
    var ptrs = {}, ptrCount = 0, pinch = 0, lastMove = 0;
    function pinchDist() {
      var ids = Object.keys(ptrs);
      if (ids.length < 2) return 0;
      var a = ptrs[ids[0]], b = ptrs[ids[1]];
      return Math.sqrt(sq(a.x - b.x) + sq(a.y - b.y));
    }
    function onDown(e) {
      interacted = true; vel = 0;
      if (!ptrs[e.pointerId]) ptrCount++;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      canvas.style.cursor = 'grabbing';
      if (ptrCount === 2) pinch = pinchDist();
      lastMove = e.timeStamp || 0;
    }
    function onMove(e) {
      var p = ptrs[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrCount === 1) {
        yaw += dx * 0.0085;
        tilt = clamp(tilt + dy * 0.005, TILT_MIN, TILT_MAX);
        var ts = e.timeStamp || 0, dtm = Math.max(8, ts - lastMove) / 1000;
        lastMove = ts;
        vel = clamp(lerp(vel, dx * 0.0085 / dtm, 0.5), -4, 4);
      } else if (ptrCount >= 2) {
        var d = pinchDist();
        if (pinch > 0 && d > 0) { zoom = clamp(zoom * d / pinch, ZOOM_MIN, ZOOM_MAX); fit(); }
        pinch = d;
      }
      dirty = true;
    }
    function onUp(e) {
      if (!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId];
      ptrCount = Math.max(0, ptrCount - 1);
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (ptrCount === 0) {
        canvas.style.cursor = 'grab';
        if ((e.timeStamp || 0) - lastMove > 90 || reduced()) vel = 0;
      }
      pinch = 0;
    }
    // колесо масштабирует только с Ctrl (или щипком на тачпаде), чтобы не перехватывать прокрутку страницы
    function onWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      interacted = true;
      zoom = clamp(zoom * Math.exp(-e.deltaY * 0.01), ZOOM_MIN, ZOOM_MAX);
      fit();
    }
    function onLost(e) { e.preventDefault(); }
    function onRestored() { dirty = true; }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    var ro = null, io = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(resize); ro.observe(container); }
    else window.addEventListener('resize', resize);
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) dirty = true;
      });
      io.observe(container);
    }
    resize();
    raf = window.requestAnimationFrame(frame);

    return {
      setWrap: function (on) {
        if (disposed) return;
        bq.wrapGroup.visible = !!on;
        dirty = true;
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        window.cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
        if (io) io.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        bq.dispose();
        renderer.dispose();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }

  window.initBouquet3D = initBouquet3D;
})();
