/** Onsets (input s) in a capture fixture's tracker input: peaks of one band, as the live-sync judge reads them. */
export function captureOnsets(c, band, T) {
  const v = c[band], spf = c.spf / c.sr, on = [], vals = [], peaks = [];
  for (let i = 1; i + 1 < v.length; i++) if (v[i] > v[i - 1] && v[i] >= v[i + 1]) peaks.push(i);
  const hi = peaks.map((i) => v[i]).sort((a, b) => a - b), ref = hi[Math.floor(hi.length * 0.9)];
  for (const i of peaks) {
    if (v[i] < 0.3 * ref) continue;
    const a = v[i - 1], b = v[i], q = v[i + 1], qq = a - 2 * b + q, x = (c.t0 + i * c.spf) / c.sr + (qq < 0 ? (0.5 * (a - q)) / qq : 0) * spf;
    if (on.length && x - on[on.length - 1] < 0.6 * T) { if (b > vals[vals.length - 1]) { on[on.length - 1] = x; vals[vals.length - 1] = b; } continue; }
    on.push(x); vals.push(b);
  }
  return on;
}
