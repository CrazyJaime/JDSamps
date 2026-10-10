// catalog.js — gallery catalogs for Movie Maker (web).
// Every entry is { id, name, group }. Groups mirror the galleries of the classic
// Movie Maker ribbon. Names are descriptive; the look-alike thumbnails are drawn
// by gallery.js through the real renderer pieces.

/** Transitions (Animations tab). */
export const TRANSITIONS = [
  { id: 'none', name: 'No transition', group: 'None' },

  // Contemporary
  { id: 'slide-left', name: 'Slide - left', group: 'Contemporary' },
  { id: 'slide-right', name: 'Slide - right', group: 'Contemporary' },
  { id: 'slide-up', name: 'Slide - up', group: 'Contemporary' },
  { id: 'slide-down', name: 'Slide - down', group: 'Contemporary' },
  { id: 'push-left', name: 'Push - left', group: 'Contemporary' },
  { id: 'push-right', name: 'Push - right', group: 'Contemporary' },
  { id: 'push-up', name: 'Push - up', group: 'Contemporary' },
  { id: 'push-down', name: 'Push - down', group: 'Contemporary' },
  { id: 'flip', name: 'Flip', group: 'Contemporary' },
  { id: 'cube', name: 'Cube', group: 'Contemporary' },
  { id: 'pixelate', name: 'Pixelate', group: 'Contemporary' },

  // Cinematic
  { id: 'filmstrip', name: 'Filmstrip', group: 'Cinematic' },
  { id: 'letterbox', name: 'Letterbox', group: 'Cinematic' },
  { id: 'flash', name: 'Flash', group: 'Cinematic' },

  // Diagonals
  { id: 'diagonal-box', name: 'Diagonal - box out', group: 'Diagonals' },
  { id: 'diagonal-cross', name: 'Diagonal - cross out', group: 'Diagonals' },
  { id: 'diagonal-down', name: 'Diagonal - down right', group: 'Diagonals' },
  { id: 'diagonal-up', name: 'Diagonal - up right', group: 'Diagonals' },

  // Dissolves
  { id: 'crossfade', name: 'Crossfade', group: 'Dissolves' },
  { id: 'dissolve', name: 'Dissolve - rough', group: 'Dissolves' },
  { id: 'blur', name: 'Dissolve - blur', group: 'Dissolves' },
  { id: 'fade-black', name: 'Fade through black', group: 'Dissolves' },
  { id: 'fade-white', name: 'Fade through white', group: 'Dissolves' },

  // Patterns and shapes
  { id: 'iris-in', name: 'Circle - in', group: 'Patterns and shapes' },
  { id: 'iris-out', name: 'Circle - out', group: 'Patterns and shapes' },
  { id: 'diamond', name: 'Diamond', group: 'Patterns and shapes' },
  { id: 'heart', name: 'Heart', group: 'Patterns and shapes' },
  { id: 'star', name: 'Star', group: 'Patterns and shapes' },
  { id: 'checkerboard', name: 'Checkerboard', group: 'Patterns and shapes' },
  { id: 'circles', name: 'Circles', group: 'Patterns and shapes' },
  { id: 'cross', name: 'Plus', group: 'Patterns and shapes' },

  // Reveals
  { id: 'barn-doors', name: 'Barn doors', group: 'Reveals' },
  { id: 'split-h', name: 'Split - horizontal', group: 'Reveals' },
  { id: 'split-v', name: 'Split - vertical', group: 'Reveals' },
  { id: 'reveal-left', name: 'Reveal - left', group: 'Reveals' },
  { id: 'reveal-right', name: 'Reveal - right', group: 'Reveals' },
  { id: 'zoom-in', name: 'Zoom - in', group: 'Reveals' },
  { id: 'zoom-out', name: 'Zoom - out', group: 'Reveals' },

  // Shatters
  { id: 'shatter', name: 'Shatter - out', group: 'Shatters' },
  { id: 'shatter-in', name: 'Shatter - in', group: 'Shatters' },

  // Sweeps and curls
  { id: 'clock', name: 'Sweep - clockwise', group: 'Sweeps and curls' },
  { id: 'wheel', name: 'Wheel - 4 spokes', group: 'Sweeps and curls' },
  { id: 'fan', name: 'Sweep - up', group: 'Sweeps and curls' },
  { id: 'page-curl', name: 'Page curl', group: 'Sweeps and curls' },
  { id: 'roll', name: 'Roll', group: 'Sweeps and curls' },

  // Wipes
  { id: 'wipe-left', name: 'Wipe - left', group: 'Wipes' },
  { id: 'wipe-right', name: 'Wipe - right', group: 'Wipes' },
  { id: 'wipe-up', name: 'Wipe - up', group: 'Wipes' },
  { id: 'wipe-down', name: 'Wipe - down', group: 'Wipes' },
  { id: 'blinds-h', name: 'Blinds - horizontal', group: 'Wipes' },
  { id: 'blinds-v', name: 'Blinds - vertical', group: 'Wipes' },
  { id: 'bars', name: 'Bars - random', group: 'Wipes' },
];

/** Pan and zoom (Animations tab). */
export const PANZOOM = [
  { id: 'none', name: 'No pan and zoom', group: 'None' },
  { id: 'auto', name: 'Automatic', group: 'Automatic' },

  { id: 'pan-left', name: 'Pan left', group: 'Pan' },
  { id: 'pan-right', name: 'Pan right', group: 'Pan' },
  { id: 'pan-up', name: 'Pan up', group: 'Pan' },
  { id: 'pan-down', name: 'Pan down', group: 'Pan' },

  { id: 'zoom-in', name: 'Zoom in', group: 'Zoom' },
  { id: 'zoom-out', name: 'Zoom out', group: 'Zoom' },
  { id: 'zoom-in-left', name: 'Zoom in left', group: 'Zoom' },
  { id: 'zoom-in-right', name: 'Zoom in right', group: 'Zoom' },
  { id: 'zoom-in-top', name: 'Zoom in top', group: 'Zoom' },
  { id: 'zoom-in-bottom', name: 'Zoom in bottom', group: 'Zoom' },
  { id: 'zoom-out-left', name: 'Zoom out left', group: 'Zoom' },
  { id: 'zoom-out-right', name: 'Zoom out right', group: 'Zoom' },
  { id: 'zoom-out-top', name: 'Zoom out top', group: 'Zoom' },
  { id: 'zoom-out-bottom', name: 'Zoom out bottom', group: 'Zoom' },
];

/** Visual effects (Visual Effects tab). */
export const EFFECTS = [
  { id: 'none', name: 'No effect', group: 'None' },

  // Artistic
  { id: 'edge', name: 'Edge detection', group: 'Artistic' },
  { id: 'emboss', name: 'Emboss', group: 'Artistic' },
  { id: 'posterize', name: 'Posterize', group: 'Artistic' },
  { id: 'pixelate', name: 'Pixelate', group: 'Artistic' },
  { id: 'invert', name: 'Negative', group: 'Artistic' },

  // Black and white
  { id: 'bw', name: 'Black and white', group: 'Black and white' },
  { id: 'bw-orange', name: 'Black and white - orange filter', group: 'Black and white' },
  { id: 'bw-red', name: 'Black and white - red filter', group: 'Black and white' },
  { id: 'bw-yellow', name: 'Black and white - yellow filter', group: 'Black and white' },
  { id: 'sepia', name: 'Sepia tone', group: 'Black and white' },
  { id: 'cyan', name: 'Cyan tone', group: 'Black and white' },
  { id: 'threshold', name: 'Threshold', group: 'Black and white' },

  // Cinematic
  { id: 'blur', name: 'Blur', group: 'Cinematic' },
  { id: 'vintage', name: 'Vintage', group: 'Cinematic' },
  { id: 'film-age', name: 'Film age - old', group: 'Cinematic' },
  { id: 'warm', name: 'Warm', group: 'Cinematic' },
  { id: 'cool', name: 'Cool', group: 'Cinematic' },
  { id: 'vivid', name: 'Vivid', group: 'Cinematic' },

  // Motions and fades
  { id: 'ease-in', name: 'Ease in', group: 'Motions and fades' },
  { id: 'ease-out', name: 'Ease out', group: 'Motions and fades' },
  { id: 'fade-in-black', name: 'Fade in from black', group: 'Motions and fades' },
  { id: 'fade-out-black', name: 'Fade out to black', group: 'Motions and fades' },
  { id: 'fade-in-white', name: 'Fade in from white', group: 'Motions and fades' },
  { id: 'fade-out-white', name: 'Fade out to white', group: 'Motions and fades' },
  { id: 'spin-360', name: 'Spin 360', group: 'Motions and fades' },

  // Mirror
  { id: 'mirror-h', name: 'Mirror horizontal', group: 'Mirror' },
  { id: 'mirror-v', name: 'Mirror vertical', group: 'Mirror' },
];

/** Text effects (Text Tools › Format tab). */
export const TEXT_EFFECTS = [
  { id: 'none', name: 'No effect', group: 'None' },

  // Classic
  { id: 'fade', name: 'Fade', group: 'Classic' },
  { id: 'typewriter', name: 'Typewriter', group: 'Classic' },
  { id: 'wipe', name: 'Wipe', group: 'Classic' },

  // Cinematic
  { id: 'cinematic', name: 'Cinematic - letterbox', group: 'Cinematic' },
  { id: 'scroll', name: 'Scroll (credits)', group: 'Cinematic' },
  { id: 'ticker', name: 'Ticker', group: 'Cinematic' },

  // Fly in
  { id: 'fly-left', name: 'Fly in - left', group: 'Fly in' },
  { id: 'fly-right', name: 'Fly in - right', group: 'Fly in' },
  { id: 'fly-up', name: 'Fly in - bottom', group: 'Fly in' },
  { id: 'fly-down', name: 'Fly in - top', group: 'Fly in' },

  // Emphasis
  { id: 'zoom-in', name: 'Zoom - in', group: 'Emphasis' },
  { id: 'zoom-out', name: 'Zoom - out', group: 'Emphasis' },
  { id: 'stretch', name: 'Stretch', group: 'Emphasis' },
  { id: 'swing', name: 'Swing', group: 'Emphasis' },
  { id: 'spin', name: 'Spin', group: 'Emphasis' },
  { id: 'bounce', name: 'Bounce', group: 'Emphasis' },
];

// Shared text styles for AutoMovie themes. Only TextStyle keys go in titleStyle /
// creditsStyle so they can be merged straight onto defaultTextStyle().
const SANS = 'Segoe UI, Helvetica Neue, Arial, sans-serif';
const SERIF = 'Georgia, Times New Roman, serif';

/**
 * AutoMovie themes. Contract fields: id, name, transition, panZoom, effect,
 * titleStyle, creditsStyle. Extra (optional) fields consumers may use:
 * group, transitionDuration, titleEffect, creditsEffect, titleBackground,
 * creditsBackground, description.
 */
export const AUTOMOVIE_THEMES = [
  {
    id: 'default', name: 'Default', group: 'AutoMovie themes',
    description: 'Crossfades, automatic pan and zoom and a simple fading title.',
    transition: 'crossfade', transitionDuration: 1.5, panZoom: 'auto', effect: 'none',
    titleEffect: 'fade', creditsEffect: 'scroll', titleBackground: '#000000', creditsBackground: '#000000',
    titleStyle: { font: SANS, size: 10, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
    creditsStyle: { font: SANS, size: 6, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
  },
  {
    id: 'contemporary', name: 'Contemporary', group: 'AutoMovie themes',
    description: 'Slides and pushes with flying titles.',
    transition: 'push-left', transitionDuration: 1.0, panZoom: 'auto', effect: 'none',
    titleEffect: 'fly-left', creditsEffect: 'scroll', titleBackground: '#1f3c66', creditsBackground: '#1f3c66',
    titleStyle: { font: SANS, size: 11, bold: true, italic: false, color: '#ffffff', outline: 'none', align: 'left', valign: 'bottom' },
    creditsStyle: { font: SANS, size: 6, bold: true, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
  },
  {
    id: 'cinematic', name: 'Cinematic', group: 'AutoMovie themes',
    description: 'Letterboxed titles, slow fades through black and an old-film look.',
    transition: 'fade-black', transitionDuration: 2.0, panZoom: 'auto', effect: 'none',
    titleEffect: 'cinematic', creditsEffect: 'scroll', titleBackground: '#000000', creditsBackground: '#000000',
    titleStyle: { font: SERIF, size: 9, bold: false, italic: false, color: '#f3ead2', outline: 'none', align: 'center', valign: 'middle' },
    creditsStyle: { font: SERIF, size: 6, bold: false, italic: false, color: '#f3ead2', outline: 'none', align: 'center', valign: 'middle' },
  },
  {
    id: 'fade', name: 'Fade', group: 'AutoMovie themes',
    description: 'Fades through black between every item.',
    transition: 'fade-black', transitionDuration: 1.5, panZoom: 'none', effect: 'none',
    titleEffect: 'fade', creditsEffect: 'scroll', titleBackground: '#000000', creditsBackground: '#000000',
    titleStyle: { font: SANS, size: 10, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
    creditsStyle: { font: SANS, size: 6, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
  },
  {
    id: 'pan-zoom', name: 'Pan and zoom', group: 'AutoMovie themes',
    description: 'Automatic pan and zoom with gentle crossfades.',
    transition: 'crossfade', transitionDuration: 1.25, panZoom: 'auto', effect: 'none',
    titleEffect: 'zoom-in', creditsEffect: 'scroll', titleBackground: '#000000', creditsBackground: '#000000',
    titleStyle: { font: SANS, size: 10, bold: true, italic: false, color: '#ffffff', outline: 'thin', outlineColor: '#000000', align: 'center', valign: 'middle' },
    creditsStyle: { font: SANS, size: 6, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
  },
  {
    id: 'sepia', name: 'Sepia', group: 'AutoMovie themes',
    description: 'Warm sepia tone, rough dissolves and a typewriter title.',
    transition: 'dissolve', transitionDuration: 1.5, panZoom: 'auto', effect: 'sepia',
    titleEffect: 'typewriter', creditsEffect: 'scroll', titleBackground: '#3b2a17', creditsBackground: '#3b2a17',
    titleStyle: { font: SERIF, size: 9, bold: false, italic: true, color: '#f5e6c8', outline: 'none', align: 'center', valign: 'middle' },
    creditsStyle: { font: SERIF, size: 6, bold: false, italic: false, color: '#f5e6c8', outline: 'none', align: 'center', valign: 'middle' },
  },
  {
    id: 'black-white', name: 'Black and white', group: 'AutoMovie themes',
    description: 'Classic black and white with fades and a cinematic title.',
    transition: 'crossfade', transitionDuration: 1.5, panZoom: 'auto', effect: 'bw',
    titleEffect: 'fade', creditsEffect: 'scroll', titleBackground: '#000000', creditsBackground: '#000000',
    titleStyle: { font: SERIF, size: 10, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
    creditsStyle: { font: SERIF, size: 6, bold: false, italic: false, color: '#ffffff', outline: 'none', align: 'center', valign: 'middle' },
  },
];

const _index = new WeakMap();

/** Look up a catalog entry by id (O(1) after the first call per list). */
export function byId(list, id) {
  if (!Array.isArray(list)) return undefined;
  let map = _index.get(list);
  if (!map || map.size !== list.length) {
    map = new Map();
    for (const entry of list) if (entry && entry.id != null) map.set(entry.id, entry);
    _index.set(list, map);
  }
  return map.get(id);
}

/** Distinct group names of a catalog, in first-appearance order. */
export function groupsOf(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const entry of list) if (entry && !out.includes(entry.group)) out.push(entry.group);
  return out;
}
