// ui/icons.js — colorful inline SVG icon set (Windows 7 / Live Movie Maker inspired, original art).
//
//   icon(name, size = 16) -> SVGElement   (class "ic ic-<name>", aria-hidden, not focusable)
//   iconSVG(name, size?)  -> string        (same markup as a string, for innerHTML)
//   hasIcon(name) -> boolean
//   ICON_NAMES -> string[]
//
// Every icon is drawn on a 32×32 grid and scales cleanly to 16, 20, 24 and 32 px.
// No gradients/ids are used (so many copies can live in one document safely); the glossy
// look comes from layered flat shapes and translucent highlights.

const SW = 'stroke-width';

// ---------------------------------------------------------------------------
// Reusable motifs (all return markup strings in 32-unit space)

function n(v) { return Math.round(v * 100) / 100; }

function film(x, y, w, h, pic = '#79b4ec') {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.6" fill="#34495e" stroke="#1c2a39" ${SW}="1"/>`
    + `<rect x="${n(x + 1.6)}" y="${n(y + h * 0.26)}" width="${n(w - 3.2)}" height="${n(h * 0.48)}" fill="${pic}"/>`
    + `<rect x="${n(x + 1.6)}" y="${n(y + h * 0.26)}" width="${n(w - 3.2)}" height="${n(h * 0.16)}" fill="#fff" opacity=".28"/>`;
  const count = Math.max(2, Math.round(w / 5));
  const step = w / count;
  const hy1 = n(y + h * 0.08), hy2 = n(y + h * 0.92 - 2);
  for (let i = 0; i < count; i++) {
    const hx = n(x + step * i + step / 2 - 1.1);
    s += `<rect x="${hx}" y="${hy1}" width="2.2" height="2" rx=".5" fill="#eaf2fc"/>`
      + `<rect x="${hx}" y="${hy2}" width="2.2" height="2" rx=".5" fill="#eaf2fc"/>`;
  }
  return s;
}

function photo(x, y, w, h) {
  const ix = x + 1.8, iy = y + 1.8, iw = w - 3.6, ih = h - 3.6;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="#fff" stroke="#61789a" ${SW}="1.2"/>`
    + `<rect x="${n(ix)}" y="${n(iy)}" width="${n(iw)}" height="${n(ih)}" fill="#5fa9ef"/>`
    + `<path d="M${n(ix)} ${n(iy + ih)}V${n(iy + ih * 0.62)}Q${n(ix + iw * 0.3)} ${n(iy + ih * 0.36)} ${n(ix + iw * 0.58)} ${n(iy + ih * 0.66)}T${n(ix + iw)} ${n(iy + ih * 0.56)}V${n(iy + ih)}Z" fill="#45a536"/>`
    + `<circle cx="${n(ix + iw * 0.74)}" cy="${n(iy + ih * 0.3)}" r="${n(Math.min(iw, ih) * 0.13)}" fill="#ffe25a"/>`;
}

function plusBadge(cx, cy, r = 6.2) {
  const a = n(r * 0.55);
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#3aa52f" stroke="#1f6e19" ${SW}="1.2"/>`
    + `<path d="M${n(cx - a)} ${cy}H${n(cx + a)}M${cx} ${n(cy - a)}V${n(cy + a)}" stroke="#fff" ${SW}="2.4" fill="none"/>`;
}

function upBadge(cx, cy, r = 6) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f29a1f" stroke="#a55e06" ${SW}="1.2"/>`
    + `<path d="M${cx} ${n(cy + r * 0.55)}V${n(cy - r * 0.5)}M${n(cx - r * 0.45)} ${n(cy - r * 0.05)}L${cx} ${n(cy - r * 0.55)}L${n(cx + r * 0.45)} ${n(cy - r * 0.05)}" stroke="#fff" ${SW}="2" fill="none"/>`;
}

function notes(dx = 0, dy = 0, s = 1, color = '#2d6fd0', dark = '#173f82') {
  return `<g transform="translate(${dx} ${dy}) scale(${s})">`
    + `<path d="M11 8L26 4.5V20.5" fill="none" stroke="${dark}" ${SW}="2.2"/>`
    + `<path d="M11 8V24" fill="none" stroke="${dark}" ${SW}="2.2"/>`
    + `<path d="M10 7.2L27 3.3V8.2L10 12.1Z" fill="${color}" stroke="${dark}" ${SW}="1"/>`
    + `<ellipse cx="7.6" cy="24.2" rx="4.4" ry="3.3" transform="rotate(-20 7.6 24.2)" fill="${color}" stroke="${dark}" ${SW}="1.2"/>`
    + `<ellipse cx="22.6" cy="20.8" rx="4.4" ry="3.3" transform="rotate(-20 22.6 20.8)" fill="${color}" stroke="${dark}" ${SW}="1.2"/>`
    + `<ellipse cx="6.6" cy="23.2" rx="1.6" ry="1" transform="rotate(-20 6.6 23.2)" fill="#fff" opacity=".5"/>`
    + `<ellipse cx="21.6" cy="19.8" rx="1.6" ry="1" transform="rotate(-20 21.6 19.8)" fill="#fff" opacity=".5"/>`
    + `</g>`;
}

function mic(dx = 0, dy = 0, s = 1) {
  return `<g transform="translate(${dx} ${dy}) scale(${s})">`
    + `<path d="M9 15a7 7 0 0 0 14 0" fill="none" stroke="#4d5b6b" ${SW}="2"/>`
    + `<path d="M16 22v5M11 28h10" stroke="#4d5b6b" ${SW}="2.2" fill="none"/>`
    + `<rect x="11.5" y="3" width="9" height="16" rx="4.5" fill="#8e9bab" stroke="#3c4856" ${SW}="1.3"/>`
    + `<path d="M12 8h8M12 11h8M12 14h8" stroke="#3c4856" ${SW}="1" opacity=".55"/>`
    + `<rect x="13" y="4.2" width="2.2" height="12" rx="1.1" fill="#fff" opacity=".45"/>`
    + `</g>`;
}

function arrowCurve(d, head, color = '#3d86de', dark = '#1a4f9a') {
  return `<path d="${d}" fill="none" stroke="${dark}" ${SW}="6"/>`
    + `<polygon points="${head}" fill="${color}" stroke="${dark}" ${SW}="1.3"/>`
    + `<path d="${d}" fill="none" stroke="${color}" ${SW}="3.4"/>`;
}

function magnifier(extra) {
  return `<path d="M19.5 19.5L28 28" stroke="#5a4632" ${SW}="4.6"/>`
    + `<path d="M19.5 19.5L28 28" stroke="#9c7a52" ${SW}="2.4"/>`
    + `<circle cx="13" cy="13" r="9.5" fill="#dcefff" stroke="#3b6aa8" ${SW}="2.2"/>`
    + `<path d="M7.5 10.5a6 6 0 0 1 5-4.5" stroke="#fff" ${SW}="1.8" fill="none"/>`
    + extra;
}

function speaker(dx = 0, dy = 0, s = 1) {
  return `<g transform="translate(${dx} ${dy}) scale(${s})">`
    + `<path d="M4 12h5l7-6v20l-7-6H4z" fill="#6b7d93" stroke="#33404f" ${SW}="1.3"/>`
    + `<path d="M5.2 13.2h3.5v2" stroke="#fff" ${SW}="1" opacity=".5" fill="none"/>`
    + `</g>`;
}

function textA(color = '#1f4f9b', x = 16, y = 25, size = 22, weight = 700, family = 'Segoe UI, Arial, sans-serif', extra = '') {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}" ${extra}>`;
}

function lines(x, ys, widths, color = '#4d6d93', w = 2.2) {
  return ys.map((y, i) => `<path d="M${x[i] ?? x[0]} ${y}h${widths[i]}" stroke="${color}" ${SW}="${w}"/>`).join('');
}

function monitor(x, y, w, h, screen = '#2d2d2d') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="#d6dde7" stroke="#53657c" ${SW}="1.3"/>`
    + `<rect x="${n(x + 2)}" y="${n(y + 2)}" width="${n(w - 4)}" height="${n(h - 4)}" fill="${screen}"/>`;
}

function grid(cells) {
  return cells.map(([x, y, s]) => `<rect x="${x}" y="${y}" width="${s}" height="${n(s * 0.75)}" rx=".8" fill="#6eaae9" stroke="#2c5d9c" ${SW}="1.1"/>`).join('');
}

function palette(color) {
  return `<rect x="4" y="25" width="24" height="5" rx="1" fill="${color}" stroke="#555" ${SW}="1"/>`;
}

function bucket() {
  return `<path d="M8 6l11 11-7 7-8-8z" fill="#e7edf5" stroke="#4d5d72" ${SW}="1.4"/>`
    + `<path d="M5 15h14" stroke="#4d5d72" ${SW}="1.1"/>`
    + `<path d="M21 15c2.5 3 3.5 5 3.5 6.3a2.2 2.2 0 0 1-4.4 0c0-1.3.4-3.3.9-6.3z" fill="#3a87e0" stroke="#1d5299" ${SW}="1"/>`
    + `<path d="M10 4l3 3" stroke="#4d5d72" ${SW}="1.6"/>`;
}

function slate(fill = '#1d5fb8', dark = '#0f3772') {
  return `<rect x="3" y="5" width="26" height="22" rx="2.5" fill="${fill}" stroke="${dark}" ${SW}="1.4"/>`
    + `<rect x="4.5" y="6.5" width="23" height="7" rx="1.5" fill="#fff" opacity=".22"/>`;
}

function stopwatch(dx = 0, dy = 0, s = 1, hand = 'M16 18V11M16 18l4 3') {
  return `<g transform="translate(${dx} ${dy}) scale(${s})">`
    + `<rect x="13.5" y="2" width="5" height="3.5" rx="1" fill="#6b7a8c" stroke="#38434f" ${SW}="1"/>`
    + `<path d="M24 7.5l2.2-2.2" stroke="#38434f" ${SW}="2.2"/>`
    + `<circle cx="16" cy="18" r="11" fill="#fff" stroke="#3f74b8" ${SW}="2.4"/>`
    + `<circle cx="16" cy="18" r="8.6" fill="#eef5fd"/>`
    + `<path d="M16 9.4v1.8M16 24.8v1.8M7.4 18h1.8M22.8 18h1.8" stroke="#7d93ad" ${SW}="1.3"/>`
    + `<path d="${hand}" stroke="#d2312b" ${SW}="2" fill="none"/>`
    + `<circle cx="16" cy="18" r="1.6" fill="#33404f"/>`
    + `</g>`;
}

function framePair(cx) {
  return `<rect x="2.5" y="8" width="13" height="16" rx="1" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.2"/>`
    + `<rect x="16.5" y="8" width="13" height="16" rx="1" fill="#f3a33a" stroke="#a5620b" ${SW}="1.2"/>`
    + (cx || '');
}

// ---------------------------------------------------------------------------
// The icon table (inner markup in a 0 0 32 32 viewBox)

const ICONS = {
  // ---- media & add ----
  film: film(3, 6, 26, 20),
  photos: `<g transform="rotate(-10 12 14)">${photo(3, 6, 18, 14)}</g>${photo(10, 11, 19, 15)}`,
  'add-videos': `${film(1.5, 4, 21, 15)}${photo(8, 12, 17, 13)}${plusBadge(24.5, 24.5, 6.4)}`,
  webcam: `<path d="M10 28h12" stroke="#4b5866" ${SW}="2.6"/><path d="M16 22v6" stroke="#4b5866" ${SW}="2.4"/>`
    + `<circle cx="16" cy="13" r="10.5" fill="#e9eef5" stroke="#3c4856" ${SW}="1.5"/>`
    + `<circle cx="16" cy="13" r="6.6" fill="#24313f"/><circle cx="16" cy="13" r="4.3" fill="#2f78d1"/>`
    + `<circle cx="16" cy="13" r="2" fill="#0e2a52"/><circle cx="14.3" cy="11.2" r="1.3" fill="#fff" opacity=".85"/>`
    + `<circle cx="24" cy="6" r="1.6" fill="#e53b30"/>`,
  narration: `${mic(-2, 0, 1)}<circle cx="25" cy="7" r="4.5" fill="#e3372c" stroke="#9c1c14" ${SW}="1.2"/><circle cx="23.8" cy="5.8" r="1.4" fill="#fff" opacity=".55"/>`,
  mic: mic(0, 0, 1),
  snapshot: `<path d="M10 8l2-3.5h8L22 8" fill="#7f8da0" stroke="#3a4655" ${SW}="1.2"/>`
    + `<rect x="3" y="8" width="26" height="18" rx="2.5" fill="#55657a" stroke="#2a3542" ${SW}="1.3"/>`
    + `<rect x="4.5" y="9.5" width="23" height="5" rx="1.5" fill="#fff" opacity=".18"/>`
    + `<circle cx="16" cy="17" r="6.6" fill="#dfe6ee" stroke="#2a3542" ${SW}="1.2"/>`
    + `<circle cx="16" cy="17" r="4.3" fill="#2f78d1"/><circle cx="14.6" cy="15.6" r="1.4" fill="#fff" opacity=".85"/>`
    + `<rect x="23" y="10.5" width="3.5" height="2.2" rx=".6" fill="#ffe36b"/>`,
  music: notes(0, 0, 1),
  'music-add': `${notes(-1, -1, 0.9)}${plusBadge(24.5, 24.5, 6.2)}`,
  'music-at': `${notes(-1, -1, 0.9)}<path d="M25 9v21" stroke="#2b2b2b" ${SW}="1.8"/><path d="M21.5 9h7l-3.5 4z" fill="#2b2b2b"/>`,
  title: `${slate()}${textA('#fff', 16, 24.5, 17)}A</text>`,
  caption: `${photo(2.5, 4.5, 27, 23)}<rect x="4.3" y="18" width="23.4" height="7.7" fill="#1b2633" opacity=".82"/>`
    + `<path d="M8 22h16" stroke="#fff" ${SW}="2"/>`,
  credits: `<rect x="5" y="3" width="22" height="26" rx="2" fill="#24384f" stroke="#101c2a" ${SW}="1.3"/>`
    + `${lines([10, 9, 11, 9], [9, 13.5, 18, 22.5], [12, 14, 10, 14], '#f4f7fb', 2)}`
    + `<path d="M26 18V5M23 8l3-3.4L29 8" stroke="#f29a1f" ${SW}="2.2" fill="none"/>`,
  automovie: `${film(2, 13, 22, 16)}`
    + `<path d="M12 21L27 6" stroke="#4a3220" ${SW}="3.6"/><path d="M12 21L27 6" stroke="#2c2c2c" ${SW}="2"/>`
    + `<path d="M24.6 8.4L27 6" stroke="#fff" ${SW}="2.2"/>`
    + `<path d="M22 2.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="#ffd21f" stroke="#c48a00" ${SW}=".8"/>`
    + `<path d="M29 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="#ffd21f"/>`
    + `<path d="M15.5 3.5l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5z" fill="#7cc4ff"/>`,

  // ---- clipboard & editing ----
  cut: `<path d="M12 4l9 15M20 4l-9 15" stroke="#7d8a99" ${SW}="2.6"/><path d="M12 4l9 15M20 4l-9 15" stroke="#d9e0e8" ${SW}="1"/>`
    + `<circle cx="9" cy="23.5" r="4.6" fill="none" stroke="#1f5fbf" ${SW}="2.6"/>`
    + `<circle cx="23" cy="23.5" r="4.6" fill="none" stroke="#1f5fbf" ${SW}="2.6"/>`
    + `<circle cx="16" cy="12.2" r="1.2" fill="#38434f"/>`,
  copy: `<rect x="4" y="3" width="15" height="19" rx="1.2" fill="#fff" stroke="#5c7392" ${SW}="1.3"/>`
    + `${lines([7], [8, 11.5, 15], [9, 9, 6], '#9db4d0', 1.6)}`
    + `<rect x="12" y="10" width="15" height="19" rx="1.2" fill="#fff" stroke="#2c5d9c" ${SW}="1.3"/>`
    + `${lines([15], [15, 18.5, 22, 25.5], [9, 9, 9, 6], '#5d8cc6', 1.6)}`,
  paste: `<rect x="4" y="5" width="20" height="24" rx="2" fill="#b98546" stroke="#6e4718" ${SW}="1.3"/>`
    + `<rect x="9" y="2.5" width="10" height="5" rx="1.2" fill="#c7ced8" stroke="#56606c" ${SW}="1.2"/>`
    + `<rect x="13" y="12" width="15" height="18" rx="1.2" fill="#fff" stroke="#2c5d9c" ${SW}="1.3"/>`
    + `${lines([16], [17, 20.5, 24], [9, 9, 6], '#5d8cc6', 1.6)}`,
  'rotate-left': `${photo(10, 11, 19, 16)}${arrowCurve('M7 18V12a6 6 0 0 1 6-6h4', '17,1.5 23,6 17,10.5')}`,
  'rotate-right': `${photo(3, 11, 19, 16)}${arrowCurve('M25 18V12a6 6 0 0 0-6-6h-4', '15,1.5 9,6 15,10.5')}`,
  remove: `<path d="M7 7l18 18M25 7L7 25" stroke="#8f1d14" ${SW}="7"/><path d="M7 7l18 18M25 7L7 25" stroke="#e5412f" ${SW}="4.4"/>`
    + `<path d="M8 7.5l3 3M21 7.5l3-.5" stroke="#ff9f92" ${SW}="1.2" opacity=".8"/>`,
  'select-all': `<rect x="3" y="5" width="26" height="22" rx="1.5" fill="#eaf3fe" stroke="#2f6fca" ${SW}="1.6" stroke-dasharray="3 2"/>`
    + `<rect x="6.5" y="9" width="8" height="6" rx=".6" fill="#6eaae9" stroke="#2c5d9c" ${SW}="1"/>`
    + `<rect x="17.5" y="9" width="8" height="6" rx=".6" fill="#6eaae9" stroke="#2c5d9c" ${SW}="1"/>`
    + `<rect x="6.5" y="17.5" width="8" height="6" rx=".6" fill="#6eaae9" stroke="#2c5d9c" ${SW}="1"/>`
    + `<rect x="17.5" y="17.5" width="8" height="6" rx=".6" fill="#6eaae9" stroke="#2c5d9c" ${SW}="1"/>`,
  undo: arrowCurve('M11 11h9a6.5 6.5 0 0 1 0 13h-8', '4,11 11.5,4.5 11.5,17.5'),
  redo: arrowCurve('M21 11h-9a6.5 6.5 0 0 0 0 13h8', '28,11 20.5,4.5 20.5,17.5'),

  // ---- save / file ----
  save: `<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H24l4 4v18.5a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 4 26.5z" fill="#3a7bd5" stroke="#173f80" ${SW}="1.3"/>`
    + `<rect x="9" y="4.6" width="13" height="8" fill="#e9eef5" stroke="#173f80" ${SW}="1"/><rect x="17.5" y="6" width="3" height="5" fill="#3a4b60"/>`
    + `<rect x="8" y="17" width="16" height="10" rx=".8" fill="#fff" stroke="#173f80" ${SW}="1"/>`
    + `${lines([10.5], [20, 23], [11, 11], '#9fb7d6', 1.3)}`,
  'save-as': `<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H24l4 4v18.5a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 4 26.5z" fill="#3a7bd5" stroke="#173f80" ${SW}="1.3"/>`
    + `<rect x="9" y="4.6" width="13" height="8" fill="#e9eef5" stroke="#173f80" ${SW}="1"/><rect x="8" y="17" width="16" height="10" rx=".8" fill="#fff" stroke="#173f80" ${SW}="1"/>`
    + `<path d="M15 28l2-6 12-12 4 4-12 12z" fill="#f6c343" stroke="#7a5600" ${SW}="1.2"/><path d="M15 28l2-6 4 4z" fill="#f2dfb2" stroke="#7a5600" ${SW}="1"/>`,
  'save-movie': `${film(1.5, 3, 24, 17)}`
    + `<path d="M13 13.5A1.2 1.2 0 0 1 14.2 12.3H26l3.5 3.5v12.4a1.2 1.2 0 0 1-1.2 1.2H14.2A1.2 1.2 0 0 1 13 28.2z" fill="#3a7bd5" stroke="#173f80" ${SW}="1.2"/>`
    + `<rect x="16.5" y="12.8" width="9" height="5.4" fill="#e9eef5" stroke="#173f80" ${SW}=".9"/>`
    + `<rect x="16" y="21.5" width="11" height="7" rx=".6" fill="#fff" stroke="#173f80" ${SW}=".9"/>`,
  'folder-open': `<path d="M3 8a1.5 1.5 0 0 1 1.5-1.5h7l2.5 3h12A1.5 1.5 0 0 1 27.5 11v3H3z" fill="#d9a630" stroke="#875f0b" ${SW}="1.2"/>`
    + `<path d="M3 26.5l3.5-12.5h24L27 26.5z" fill="#f7cf5c" stroke="#875f0b" ${SW}="1.3"/>`
    + `<path d="M7.5 16h21" stroke="#fff" ${SW}="1.2" opacity=".6"/>`,
  new: `<path d="M7 3h12l7 7v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="#fff" stroke="#5c7392" ${SW}="1.3"/>`
    + `<path d="M19 3v7h7" fill="#dfe8f3" stroke="#5c7392" ${SW}="1.2"/>`
    + `<path d="M11 15l1.6 3.6 3.9.4-2.9 2.6.8 3.9-3.4-2-3.4 2 .8-3.9L5.5 19l3.9-.4z" fill="#ffd21f" stroke="#b07a00" ${SW}="1"/>`,
  project: `<circle cx="16" cy="16" r="13" fill="#3e4f63" stroke="#1d2835" ${SW}="1.3"/>`
    + `<circle cx="16" cy="16" r="3" fill="#c9d3df"/>`
    + `<circle cx="16" cy="8.5" r="3.2" fill="#c9d3df"/><circle cx="16" cy="23.5" r="3.2" fill="#c9d3df"/>`
    + `<circle cx="8.5" cy="16" r="3.2" fill="#c9d3df"/><circle cx="23.5" cy="16" r="3.2" fill="#c9d3df"/>`
    + `<path d="M7 9a12 12 0 0 1 6-5" stroke="#fff" ${SW}="1.4" opacity=".35" fill="none"/>`,
  share: `<path d="M9 12H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 28h18a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 25 12h-2" fill="none" stroke="#3b5878" ${SW}="2.2"/>`
    + `<path d="M16 20V4M10.5 9.5L16 4l5.5 5.5" fill="none" stroke="#1d5fc2" ${SW}="2.6"/>`,
  export: `${film(2, 6, 18, 20)}<path d="M18 16h11M24.5 11.5L29 16l-4.5 4.5" stroke="#2f9a27" ${SW}="3" fill="none"/>`,

  // ---- transport ----
  play: `<path d="M9 5.5v21l17-10.5z" fill="#2f78d1" stroke="#163f7a" ${SW}="1.6"/><path d="M11 9v6l6-3.7z" fill="#fff" opacity=".4"/>`,
  pause: `<rect x="7" y="5.5" width="6.5" height="21" rx="1.2" fill="#2f78d1" stroke="#163f7a" ${SW}="1.5"/>`
    + `<rect x="18.5" y="5.5" width="6.5" height="21" rx="1.2" fill="#2f78d1" stroke="#163f7a" ${SW}="1.5"/>`,
  stop: `<rect x="7" y="7" width="18" height="18" rx="2" fill="#2f78d1" stroke="#163f7a" ${SW}="1.5"/>`,
  record: `<circle cx="16" cy="16" r="11" fill="#e3372c" stroke="#931a12" ${SW}="1.6"/><circle cx="12.5" cy="12.5" r="3.4" fill="#fff" opacity=".45"/>`,
  'prev-frame': `<rect x="6" y="7" width="3.6" height="18" rx="1" fill="#2f78d1" stroke="#163f7a" ${SW}="1.2"/><path d="M26 7v18L11.5 16z" fill="#2f78d1" stroke="#163f7a" ${SW}="1.4"/>`,
  'next-frame': `<rect x="22.4" y="7" width="3.6" height="18" rx="1" fill="#2f78d1" stroke="#163f7a" ${SW}="1.2"/><path d="M6 7v18l14.5-9z" fill="#2f78d1" stroke="#163f7a" ${SW}="1.4"/>`,
  'go-start': `<rect x="4" y="7" width="3.4" height="18" rx="1" fill="#2f78d1" stroke="#163f7a" ${SW}="1.2"/><path d="M18 7v18L8.5 16zM28 7v18L18.5 16z" fill="#2f78d1" stroke="#163f7a" ${SW}="1.3"/>`,
  'go-end': `<rect x="24.6" y="7" width="3.4" height="18" rx="1" fill="#2f78d1" stroke="#163f7a" ${SW}="1.2"/><path d="M4 7v18l9.5-9zM14 7v18l9.5-9z" fill="#2f78d1" stroke="#163f7a" ${SW}="1.3"/>`,
  playhead: `<path d="M16 7v23" stroke="#1d1d1d" ${SW}="2"/><path d="M10 2h12v4l-6 5-6-5z" fill="#333" stroke="#111" ${SW}="1"/>`,

  // ---- clip editing (video / music tools) ----
  split: `<rect x="2.5" y="8" width="11" height="16" rx="1" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.2"/>`
    + `<rect x="18.5" y="8" width="11" height="16" rx="1" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.2"/>`
    + `<path d="M16 3v26" stroke="#d2312b" ${SW}="2.2" stroke-dasharray="3 2"/>`
    + `<path d="M6 12h4M6 16h5M22 12h4M22 16h5" stroke="#fff" ${SW}="1.2" opacity=".7"/>`,
  trim: `${film(5, 7, 22, 18)}<path d="M8 3H4v26h4M24 3h4v26h-4" fill="none" stroke="#e8761a" ${SW}="2.6"/>`,
  'set-start': `<rect x="12" y="8" width="17" height="16" rx="1" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.2"/>`
    + `<path d="M9 4H5v24h4" fill="none" stroke="#2f9a27" ${SW}="2.8"/>`
    + `<path d="M9 16h-2" stroke="#2f9a27" ${SW}="2"/>`,
  'set-end': `<rect x="3" y="8" width="17" height="16" rx="1" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.2"/>`
    + `<path d="M23 4h4v24h-4" fill="none" stroke="#d2312b" ${SW}="2.8"/>`
    + `<path d="M23 16h2" stroke="#d2312b" ${SW}="2"/>`,
  volume: `${speaker()}<path d="M20 11.5a6 6 0 0 1 0 9M23.5 8a11 11 0 0 1 0 16" fill="none" stroke="#2f78d1" ${SW}="2.2"/>`,
  'volume-mute': `${speaker()}<path d="M20 12l8 8M28 12l-8 8" stroke="#d2312b" ${SW}="2.4"/>`,
  'fade-in': `<path d="M3 26L29 7v19z" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.3"/><path d="M8 25L28 10" stroke="#fff" ${SW}="1.2" opacity=".5"/>`
    + `<path d="M4 4h8M9 1.5L12 4 9 6.5" stroke="#2f9a27" ${SW}="1.8" fill="none"/>`,
  'fade-out': `<path d="M3 7l26 19H3z" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.3"/><path d="M4 10l20 15" stroke="#fff" ${SW}="1.2" opacity=".5"/>`
    + `<path d="M20 4h8M25 1.5L28 4l-3 2.5" stroke="#d2312b" ${SW}="1.8" fill="none"/>`,
  speed: `<path d="M4 23a12 12 0 1 1 24 0" fill="#eef5fd" stroke="#3f74b8" ${SW}="2.4"/>`
    + `<path d="M4 23h24" stroke="#3f74b8" ${SW}="2"/>`
    + `<path d="M8 15l2 1.2M16 8.5V11M24 15l-2 1.2" stroke="#7d93ad" ${SW}="1.6"/>`
    + `<path d="M7 20.5a9.5 9.5 0 0 1 3-6.5" stroke="#2f9a27" ${SW}="2.4" fill="none"/><path d="M22 14a9.5 9.5 0 0 1 3 6.5" stroke="#d2312b" ${SW}="2.4" fill="none"/>`
    + `<path d="M16 22L22.5 13" stroke="#33404f" ${SW}="2.4"/><circle cx="16" cy="22" r="2.4" fill="#33404f"/>`,
  duration: stopwatch(),
  'start-time': `${stopwatch(-2, 0, 1, 'M16 18V11')}<path d="M24 22v9M24 22l6 2.5-6 2.5" fill="#2f9a27" stroke="#1b6315" ${SW}="1.4"/>`,
  'background-color': `${bucket()}${palette('#e53b30')}`,
  'apply-all': `<rect x="9" y="3" width="20" height="15" rx="1" fill="#a9cdf3" stroke="#2c5d9c" ${SW}="1.1"/>`
    + `<rect x="6" y="6.5" width="20" height="15" rx="1" fill="#7cb6ee" stroke="#2c5d9c" ${SW}="1.1"/>`
    + `<rect x="3" y="10" width="20" height="15" rx="1" fill="#5fa9ef" stroke="#2c5d9c" ${SW}="1.2"/>`
    + `<circle cx="23.5" cy="23.5" r="6.5" fill="#3aa52f" stroke="#1f6e19" ${SW}="1.2"/><path d="M20.2 23.6l2.3 2.4 4.3-4.6" stroke="#fff" ${SW}="2.2" fill="none"/>`,

  // ---- animations / effects ----
  transition: `${framePair()}<path d="M13 28L19 4" stroke="#fff" ${SW}="3.4"/><path d="M13 28L19 4" stroke="#33404f" ${SW}="1.2"/>`,
  panzoom: `${photo(2, 4, 28, 24)}<rect x="9" y="10" width="14" height="11" fill="none" stroke="#fff" ${SW}="1.8" stroke-dasharray="2.5 1.5"/>`
    + `<path d="M5 7l4 3M27 7l-4 3M5 25l4-4M27 25l-4-4" stroke="#fff" ${SW}="1.6"/>`,
  effects: `<circle cx="11.5" cy="12" r="7.5" fill="#e5412f" opacity=".85"/><circle cx="20.5" cy="12" r="7.5" fill="#3aa52f" opacity=".85"/>`
    + `<circle cx="16" cy="20" r="7.5" fill="#2f78d1" opacity=".85"/>`
    + `<path d="M26 22l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="#ffd21f" stroke="#b07a00" ${SW}=".7"/>`,
  brightness: `<circle cx="16" cy="16" r="6.5" fill="#ffd21f" stroke="#c48a00" ${SW}="1.4"/>`
    + `<path d="M16 2.5v4M16 25.5v4M2.5 16h4M25.5 16h4M6.4 6.4l2.8 2.8M22.8 22.8l2.8 2.8M6.4 25.6l2.8-2.8M22.8 9.2l2.8-2.8" stroke="#e8a400" ${SW}="2.2"/>`
    + `<circle cx="14" cy="14" r="2.2" fill="#fff" opacity=".6"/>`,
  'text-effects': `${textA('#1f4f9b', 13, 25, 22)}A</text>`
    + `<path d="M25 4l1.2 2.8 2.8 1.2-2.8 1.2L25 12l-1.2-2.8L21 8l2.8-1.2z" fill="#ffd21f" stroke="#b07a00" ${SW}=".8"/>`
    + `<path d="M27.5 16l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="#f29a1f"/>`,

  // ---- project tab ----
  'audio-mix': `<path d="M4 16h24" stroke="#7d8ea3" ${SW}="3"/><path d="M4 16h24" stroke="#dfe7f1" ${SW}="1"/>`
    + `<rect x="13" y="9.5" width="6" height="13" rx="1.5" fill="#e9eef5" stroke="#3c4856" ${SW}="1.3"/>`
    + `${film(1, 2, 10, 8)}${notes(19, 1, 0.38)}`
    + `<path d="M3 26h8M21 26h8" stroke="#2f78d1" ${SW}="2" stroke-dasharray="1.5 1.5"/>`,
  'emphasize-narration': `${mic(-3, 2, 0.9)}${upBadge(24.5, 8)}`,
  'emphasize-video': `${film(2, 10, 20, 16)}${upBadge(24.5, 8)}`,
  'emphasize-music': `${notes(-2, 4, 0.85)}${upBadge(24.5, 8)}`,
  'fit-to-music': `${film(2, 3, 28, 12)}${notes(9, 15, 0.5, '#2f9a27', '#1b6315')}`
    + `<path d="M3 23h5M3 23l2.5-2.5M3 23l2.5 2.5M29 23h-5M29 23l-2.5-2.5M29 23l-2.5 2.5" stroke="#e8761a" ${SW}="1.8" fill="none"/>`,
  waveform: `<path d="M3 16h26" stroke="#1b6315" ${SW}="1"/>`
    + `<path d="M4 13v6M7 9v14M10 12v8M13 5v22M16 10v12M19 7v18M22 12v8M25 9v14M28 14v4" stroke="#36a32a" ${SW}="2.2"/>`,
  'aspect-wide': `${monitor(2, 7, 28, 16.5, '#5fa9ef')}<text x="16" y="18.8" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="700" fill="#fff">16:9</text>`
    + `<path d="M12 27h8" stroke="#53657c" ${SW}="2"/>`,
  'aspect-standard': `${monitor(5, 5, 22, 17.5, '#5fa9ef')}<text x="16" y="17" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="700" fill="#fff">4:3</text>`
    + `<path d="M12 26.5h8" stroke="#53657c" ${SW}="2"/>`,
  'aspect-portrait': `<rect x="9" y="2" width="14" height="28" rx="2.5" fill="#2e3a48" stroke="#141c25" ${SW}="1.2"/>`
    + `<rect x="10.5" y="5" width="11" height="21" fill="#5fa9ef"/><circle cx="16" cy="28" r=".9" fill="#9aa8b8"/>`
    + `<text x="16" y="18.5" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="6" font-weight="700" fill="#fff">9:16</text>`,
  'aspect-square': `${monitor(5, 5, 22, 22, '#5fa9ef')}<text x="16" y="19" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="700" fill="#fff">1:1</text>`,

  // ---- view tab ----
  'zoom-in': magnifier(`<path d="M8.5 13h9M13 8.5v9" stroke="#1d4f99" ${SW}="2.4"/>`),
  'zoom-out': magnifier(`<path d="M8.5 13h9" stroke="#1d4f99" ${SW}="2.4"/>`),
  'zoom-reset': magnifier(`<text x="13" y="16.2" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="8" font-weight="700" fill="#1d4f99">1:1</text>`),
  'thumb-small': grid([[3, 5, 7], [12.5, 5, 7], [22, 5, 7], [3, 13.5, 7], [12.5, 13.5, 7], [22, 13.5, 7], [3, 22, 7], [12.5, 22, 7], [22, 22, 7]]),
  'thumb-medium': grid([[3, 6, 12], [17, 6, 12], [3, 18, 12], [17, 18, 12]]),
  'thumb-large': grid([[3, 6, 26]]) + `<path d="M7 22l6-6 4 4 3-3 6 6" stroke="#fff" ${SW}="1.6" fill="none" opacity=".8"/>`,
  'preview-size': `${monitor(3, 4, 26, 20)}<path d="M8 14V9h5M24 14v5h-5" stroke="#fff" ${SW}="1.8" fill="none"/><path d="M12 28h8" stroke="#53657c" ${SW}="2"/>`,
  fullscreen: `<rect x="5" y="7" width="22" height="18" rx="1" fill="#2d2d2d" stroke="#53657c" ${SW}="1.2"/>`
    + `<path d="M3 10V4h6M23 4h6v6M29 22v6h-6M9 28H3v-6" stroke="#2f78d1" ${SW}="2.4" fill="none"/>`,
  'exit-fullscreen': `<path d="M10 3v7H3M22 3v7h7M29 22h-7v7M3 22h7v7" stroke="#2f78d1" ${SW}="2.6" fill="none"/>`,

  // ---- text tools ----
  font: `${textA('#1f4f9b', 12, 24, 22, 700, 'Georgia, serif')}A</text>${textA('#2f9a27', 24.5, 26, 14, 700, 'Segoe UI, Arial, sans-serif')}a</text>`,
  'font-grow': `${textA('#1f4f9b', 12, 26, 22)}A</text><path d="M25 16V5M21 9l4-4 4 4" stroke="#2f9a27" ${SW}="2.2" fill="none"/>`,
  'font-shrink': `${textA('#1f4f9b', 12, 26, 18)}A</text><path d="M25 5v11M21 12l4 4 4-4" stroke="#d2312b" ${SW}="2.2" fill="none"/>`,
  bold: `${textA('#22303f', 16, 25, 23, 900)}B</text>`,
  italic: `${textA('#22303f', 16, 25, 24, 400, 'Georgia, Times New Roman, serif', 'font-style="italic"')}I</text>`,
  'align-left': lines([4, 4, 4, 4], [7, 12.5, 18, 23.5], [24, 16, 22, 13], '#33506f', 2.4),
  'align-center': lines([4, 8, 5, 9.5], [7, 12.5, 18, 23.5], [24, 16, 22, 13], '#33506f', 2.4),
  'align-right': lines([4, 12, 6, 15], [7, 12.5, 18, 23.5], [24, 16, 22, 13], '#33506f', 2.4),
  'text-color': `${textA('#22303f', 16, 21, 19)}A</text>${palette('#e53b30')}`,
  outline: `<text x="16" y="25" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="900" fill="#fff" stroke="#1f4f9b" ${SW}="1.8">A</text>`,
  'outline-color': `<text x="16" y="21" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="900" fill="#fff" stroke="#1f4f9b" ${SW}="1.6">A</text>${palette('#1f1f1f')}`,
  transparency: `<rect x="4" y="4" width="24" height="24" rx="1.5" fill="#fff" stroke="#5c7392" ${SW}="1.2"/>`
    + `<path d="M4 4h6v6H4zM16 4h6v6h-6zM10 10h6v6h-6zM22 10h6v6h-6zM4 16h6v6H4zM16 16h6v6h-6zM10 22h6v6h-6zM22 22h6v6h-6z" fill="#c8d2de"/>`
    + `<path d="M4 28L28 4v24z" fill="#2f78d1" opacity=".75"/>`,
  'edit-text': `${textA('#1f4f9b', 11, 22, 20)}A</text>`
    + `<path d="M14 29l1.5-5 10-10 3.5 3.5-10 10z" fill="#f6c343" stroke="#7a5600" ${SW}="1.2"/><path d="M14 29l1.5-5 3.5 3.5z" fill="#f2dfb2" stroke="#7a5600" ${SW}=".9"/>`
    + `<path d="M23.5 16l3.5 3.5" stroke="#7a5600" ${SW}="1"/>`,
  'text-duration': `${stopwatch(4, 4, 0.85)}${textA('#1f4f9b', 7, 12, 11)}A</text>`,

  // ---- general UI ----
  menu: `<path d="M5 9h22M5 16h22M5 23h22" stroke="#2c4f7c" ${SW}="2.8"/>`,
  help: `<circle cx="16" cy="16" r="13" fill="#2f78d1" stroke="#163f7a" ${SW}="1.4"/><path d="M6 12a11 11 0 0 1 9-8" stroke="#fff" ${SW}="1.6" opacity=".4" fill="none"/>`
    + `<path d="M12 12.5a4 4 0 1 1 5.6 3.6c-1 .5-1.6 1.2-1.6 2.4v1" stroke="#fff" ${SW}="2.8" fill="none"/><circle cx="16" cy="23.5" r="1.8" fill="#fff"/>`,
  info: `<circle cx="16" cy="16" r="13" fill="#2f78d1" stroke="#163f7a" ${SW}="1.4"/>`
    + `<circle cx="16" cy="9.5" r="2" fill="#fff"/><path d="M16 14v10" stroke="#fff" ${SW}="3.2"/>`,
  warning: `<path d="M16 3L30 28H2z" fill="#ffd21f" stroke="#9c6b00" ${SW}="1.4"/><path d="M16 11v8" stroke="#33404f" ${SW}="3"/><circle cx="16" cy="23.5" r="1.7" fill="#33404f"/>`,
  error: `<circle cx="16" cy="16" r="13" fill="#e3372c" stroke="#931a12" ${SW}="1.4"/><path d="M11 11l10 10M21 11L11 21" stroke="#fff" ${SW}="3"/>`,
  close: `<path d="M8 8l16 16M24 8L8 24" stroke="#4d5b6b" ${SW}="2.8"/>`,
  check: `<path d="M5 17l7 7L27 8" stroke="#1b6315" ${SW}="5" fill="none"/><path d="M5 17l7 7L27 8" stroke="#3aa52f" ${SW}="3" fill="none"/>`,
  'chevron-down': `<path d="M8 12l8 8 8-8" stroke="#2c4f7c" ${SW}="2.8" fill="none"/>`,
  'chevron-up': `<path d="M8 20l8-8 8 8" stroke="#2c4f7c" ${SW}="2.8" fill="none"/>`,
  'chevron-left': `<path d="M20 8l-8 8 8 8" stroke="#2c4f7c" ${SW}="2.8" fill="none"/>`,
  'chevron-right': `<path d="M12 8l8 8-8 8" stroke="#2c4f7c" ${SW}="2.8" fill="none"/>`,
  'caret-down': `<path d="M9 12h14l-7 8z" fill="#3b4a5c"/>`,
  'gallery-expand': `<path d="M6 7h20" stroke="#3b4a5c" ${SW}="2"/><path d="M9 13h14l-7 8z" fill="#3b4a5c"/>`,
  settings: `<path d="M16 3l2.2 3.6 4.1-1 1 4.1L27 12l-2.2 4 2.2 4-3.7 2.3-1 4.1-4.1-1L16 29l-2.2-3.6-4.1 1-1-4.1L5 20l2.2-4L5 12l3.7-2.3 1-4.1 4.1 1z" fill="#8e9bab" stroke="#3c4856" ${SW}="1.3"/>`
    + `<circle cx="16" cy="16" r="4.5" fill="#fff" stroke="#3c4856" ${SW}="1.3"/>`,
  edit: `<path d="M5 27l2-7 14-14 5 5-14 14z" fill="#f6c343" stroke="#7a5600" ${SW}="1.3"/><path d="M5 27l2-7 5 5z" fill="#f2dfb2" stroke="#7a5600" ${SW}="1"/><path d="M18 9l5 5" stroke="#7a5600" ${SW}="1.2"/>`,
  trash: `<path d="M7 9h18l-1.6 19a1.5 1.5 0 0 1-1.5 1.3H10.1a1.5 1.5 0 0 1-1.5-1.3z" fill="#c9d3df" stroke="#4d5b6b" ${SW}="1.3"/>`
    + `<path d="M5 8h22M13 8V4.5h6V8M12.5 13v12M16 13v12M19.5 13v12" stroke="#4d5b6b" ${SW}="1.6" fill="none"/>`,
  download: `<path d="M16 4v16M9.5 13.5L16 20l6.5-6.5" stroke="#1d5fc2" ${SW}="2.8" fill="none"/><path d="M5 22v5h22v-5" stroke="#3b5878" ${SW}="2.4" fill="none"/>`,
  recent: stopwatch(0, 0, 1, 'M16 18V11M16 18h5'),
};

// Aliases (alternative names other modules may reasonably use).
const ALIASES = {
  'add-video': 'add-videos', 'add-media': 'add-videos', 'add-photos': 'add-videos', video: 'film', videos: 'film',
  photo: 'photos', image: 'photos', camera: 'snapshot', microphone: 'narration', 'record-narration': 'narration',
  'add-music': 'music-add', 'music-note': 'music', 'add-music-at': 'music-at', 'music-at-playhead': 'music-at',
  'snapshot-camera': 'snapshot', 'narration-mic': 'mic', delete: 'remove', 'remove-red': 'remove',
  'save-project': 'save', open: 'folder-open', 'open-project': 'folder-open', 'new-project': 'new',
  'previous-frame': 'prev-frame', 'prev': 'prev-frame', next: 'next-frame', rewind: 'go-start', 'go-beginning': 'go-start',
  'trim-tool': 'trim', 'start-point': 'set-start', 'end-point': 'set-end', 'set-start-point': 'set-start', 'set-end-point': 'set-end',
  'video-volume': 'volume', 'music-volume': 'volume', mute: 'volume-mute',
  bg: 'background-color', 'bg-color': 'background-color', color: 'text-color', 'font-color': 'text-color',
  'emphasize': 'emphasize-narration', 'fit-music': 'fit-to-music', waveforms: 'waveform',
  'aspect-16-9': 'aspect-wide', 'aspect-4-3': 'aspect-standard', 'aspect-9-16': 'aspect-portrait', 'aspect-1-1': 'aspect-square',
  widescreen: 'aspect-wide', standard: 'aspect-standard', portrait: 'aspect-portrait', square: 'aspect-square',
  'thumbnail-small': 'thumb-small', 'thumbnail-medium': 'thumb-medium', 'thumbnail-large': 'thumb-large',
  'thumbnails': 'thumb-medium', 'thumbnail-size': 'thumb-medium',
  hamburger: 'menu', about: 'info', x: 'close', ok: 'check', done: 'check',
  transitions: 'transition', 'pan-zoom': 'panzoom', 'pan-and-zoom': 'panzoom', effect: 'effects', 'visual-effects': 'effects',
  'text-effect': 'text-effects', mix: 'audio-mix', clock: 'duration', time: 'start-time', 'text-start-time': 'start-time',
  'auto-movie': 'automovie', theme: 'automovie', text: 'title', 'add-title': 'title', 'add-caption': 'caption', 'add-credits': 'credits',
  'zoom-default': 'zoom-reset', reset: 'zoom-reset', 'full-screen': 'fullscreen', expand: 'gallery-expand',
  'dropdown': 'caret-down', alert: 'warning', 'trash-can': 'trash', pencil: 'edit',
};

export const ICON_NAMES = Object.keys(ICONS);

let _warned = null;
function resolve(name) {
  const key = String(name || '');
  if (ICONS[key]) return key;
  if (ALIASES[key] && ICONS[ALIASES[key]]) return ALIASES[key];
  if (!_warned) _warned = new Set();
  if (!_warned.has(key)) {
    _warned.add(key);
    if (typeof console !== 'undefined') console.warn(`[icons] unknown icon "${key}", using a placeholder`);
  }
  return null;
}

const PLACEHOLDER = `<rect x="5" y="5" width="22" height="22" rx="3" fill="#e4ebf4" stroke="#7d8ea3" ${SW}="1.4"/><circle cx="16" cy="16" r="3" fill="#7d8ea3"/>`;

/** True if `name` (or an alias) exists. */
export function hasIcon(name) {
  const key = String(name || '');
  return !!(ICONS[key] || (ALIASES[key] && ICONS[ALIASES[key]]));
}

function inner(name) {
  const key = resolve(name);
  return key ? ICONS[key] : PLACEHOLDER;
}

/** Icon markup as a string (for innerHTML). */
export function iconSVG(name, size) {
  const s = Number(size) > 0 ? Number(size) : null;
  const key = resolve(name) || 'placeholder';
  const dims = s ? ` width="${s}" height="${s}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${dims} class="ic ic-${key}" aria-hidden="true" focusable="false" stroke-linejoin="round" stroke-linecap="round">${inner(name)}</svg>`;
}

// Parsed templates are cached per icon name and cloned (cheap) for each use.
const _tplCache = new Map();

/** Icon as an SVGElement of the given pixel size (default 16). */
export function icon(name, size = 16) {
  const s = Number(size) > 0 ? Number(size) : 16;
  const key = resolve(name) || '__placeholder';
  let tpl = _tplCache.get(key);
  if (!tpl) {
    if (typeof document === 'undefined') throw new Error('icon() needs a DOM; use iconSVG() instead');
    const holder = document.createElement('div');
    holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false" stroke-linejoin="round" stroke-linecap="round">${key === '__placeholder' ? PLACEHOLDER : ICONS[key]}</svg>`;
    tpl = holder.firstChild;
    tpl.setAttribute('class', `ic ic-${key === '__placeholder' ? 'placeholder' : key}`);
    _tplCache.set(key, tpl);
  }
  const el = tpl.cloneNode(true);
  el.setAttribute('width', String(s));
  el.setAttribute('height', String(s));
  return el;
}
