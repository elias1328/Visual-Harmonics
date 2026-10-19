// lab.js - the Lab tab, shown as "Archive · early prototypes": the original prototype pages, opened in an iframe (#lab/<card id>).
// The route id stays 'lab' (the tab strip is app.js's).
(function () {
  'use strict';
  const VH = window.VH, ui = VH.ui;
  const CARDS = [
    { id: 'maps', url: 'prototypes/index.html', title: 'Harmony maps', text: 'Four ways to map harmony: Hz × Hz, triads, Ford circles and the pitch spiral.', art: art1 },
    { id: 'timbre', url: 'prototypes/timbre.html', title: 'Timbre lab', text: 'Shape a sound’s overtones and watch its dissonance curve re-form.', art: art2 },
    { id: 'morph', url: 'prototypes/morph.html', title: 'Morph map', text: 'A live GPU harmony map that reshapes as you change the sound’s physics.', art: art3 },
    { id: 'spiral', url: 'prototypes/spiral.html', title: 'Spiral instrument', text: 'The first pitch spiral: play it and watch overtones of different notes line up.', art: art4 },
    { id: 'melody', url: 'prototypes/melody.html', title: 'Melody sketch', text: 'Draw a tune over the harmony map of a chord progression.', art: art5 },
    { id: 'babel', url: 'prototypes/babel.html', title: 'Mini Babel', text: 'An infinite map of every sound one little synth can make.', art: art6 },
  ];
  // Small generative card art (inline SVG, harmony palette).
  function art1() {
    let s = '';
    for (let q = 1; q <= 7; q++) for (let p = q; p <= 2 * q; p++) {
      if (gcd(p, q) !== 1) continue;
      const x = 30 + (p / q - 1) * 180, r = 22 / (q * q);
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + (98 - r).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="none" stroke="' + (q < 3 ? '#00bfdc' : '#611a8c') + '" stroke-width="1.5"/>';
    }
    return s;
  }
  function art2() {
    let d = 'M0 90';
    for (let x = 0; x <= 240; x += 3) {
      const r = 1 + x / 240, y = 90 - 60 * [1, 1.2, 1.25, 1.333, 1.5, 1.667, 2].reduce((m, c) => Math.max(m, Math.exp(-((r - c) ** 2) / 0.0006)), 0);
      d += ' L' + x + ' ' + y.toFixed(1);
    }
    return '<path d="' + d + '" fill="none" stroke="#9ff" stroke-width="1.6"/>';
  }
  function art3() {
    let s = '';
    for (let i = 0; i < 12; i++) s += '<ellipse cx="120" cy="55" rx="' + (10 + i * 9) + '" ry="' + (6 + i * 4) + '" fill="none" stroke="' + ['#611a8c', '#00bfdc', '#6fa3ff'][i % 3] + '" stroke-opacity="' + (1 - i / 14).toFixed(2) + '"/>';
    return s;
  }
  function art4() {
    let d = '';
    for (let i = 0; i <= 240; i++) { const o = i / 60, a = 2 * Math.PI * o, r = 6 + o * 11; d += (i ? ' L' : 'M') + (120 + r * Math.sin(a)).toFixed(1) + ' ' + (55 - r * Math.cos(a)).toFixed(1); }
    return '<path d="' + d + '" fill="none" stroke="#6fa3ff" stroke-opacity="0.75" stroke-width="1.3"/>' +
      [[0, 0], [4, 1], [7, 1]].map(([s, o]) => { const f = (s / 12 + o + 1), a = 2 * Math.PI * f, r = 6 + f * 11; return '<circle cx="' + (120 + r * Math.sin(a)).toFixed(1) + '" cy="' + (55 - r * Math.cos(a)).toFixed(1) + '" r="4" fill="#9ff"/>'; }).join('');
  }
  function art5() {
    let s = '';
    for (let k = 0; k < 6; k++) s += '<rect x="0" y="' + (12 + k * 16) + '" width="240" height="9" fill="' + ['#611a8c', '#00bfdc', '#611a8c'][k % 3] + '" fill-opacity="' + (0.18 + 0.1 * (k % 2)) + '"/>';
    let d = 'M10 70';
    for (let x = 10; x <= 230; x += 4) d += ' L' + x + ' ' + (60 - 28 * Math.sin(x / 26) * Math.cos(x / 61)).toFixed(1);
    return s + '<path d="' + d + '" fill="none" stroke="#ffc93c" stroke-width="2" stroke-linecap="round"/>';
  }
  function art6() {
    let s = '';
    for (let j = 0; j < 11; j++) for (let i = 0; i < 24; i++) {
      const v = 0.5 + 0.5 * Math.sin(i * 0.7 + j * 0.45) * Math.cos(i * 0.23 - j * 0.9);
      s += '<rect x="' + i * 10 + '" y="' + j * 10 + '" width="10" height="10" fill="' + (v > 0.72 ? '#9ff' : v > 0.4 ? '#00bfdc' : '#611a8c') + '" fill-opacity="' + (0.25 + 0.6 * v).toFixed(2) + '"/>';
    }
    return s;
  }
  function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

  let root = null;
  function render(sub) {
    if (!root) return;
    root.innerHTML = '';
    let card = CARDS.find((c) => c.id === sub);
    if (card) {
      const f = ui.h('div', 'vh-frame');
      const bar = ui.h('div', 'vh-frame-bar');
      ui.button(bar, { label: '← Archive', onClick: () => { location.hash = '#lab'; } });
      const name = ui.h('span', '', ui.esc(card.title));
      bar.append(name);
      const ifr = ui.h('iframe');
      ifr.src = card.url; ifr.title = card.title;
      ifr.setAttribute('allow', 'autoplay');
      // The prototypes link to each other inside the frame: follow along in the bar and the address (http only;
      // file:// frames are opaque, so the bar keeps the first title there).
      ifr.addEventListener('load', () => {
        let file = '';
        try { file = ifr.contentWindow.location.pathname.split('/').pop(); } catch (_) { return; }
        const c = CARDS.find((x) => x.url.split('/').pop() === file);
        if (!c || c === card) return;
        card = c; name.textContent = c.title; ifr.title = c.title;
        try { history.replaceState(null, '', '#lab/' + c.id); VH.app.sub = c.id; } catch (_) { /* ignore */ }
      });
      f.append(bar, ifr);
      root.append(f);
      return;
    }
    const wrap = ui.h('div', 'vh-lab');
    wrap.append(ui.h('h1', '', 'Archive · early prototypes'), ui.h('p', '', 'The first experiments Visual Harmonics grew from.'));
    const grid = ui.h('div', 'vh-cards');
    for (const c of CARDS) {
      const b = ui.h('button', 'vh-card');
      b.type = 'button';
      b.innerHTML = '<svg class="art" viewBox="0 0 240 110" preserveAspectRatio="xMidYMid slice" style="background:#080a28" aria-hidden="true">' + c.art() +
        '</svg><div class="txt"><b>' + ui.esc(c.title) + '</b><span>' + ui.esc(c.text) + '</span></div>';
      b.addEventListener('click', () => { location.hash = '#lab/' + c.id; });
      grid.append(b);
    }
    wrap.append(grid);
    root.append(wrap);
  }

  VH.registerExperiment({
    id: 'lab', title: 'Lab', icon: '⚗', hint: '',
    mount(el) { root = el; render(VH.app.sub); },
    onRoute(sub) { render(sub); },
    unmount() { if (root) root.innerHTML = ''; root = null; },   // removing the iframe stops its audio
  });
})();
