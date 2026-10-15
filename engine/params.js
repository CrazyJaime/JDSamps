// engine/params.js — click-free AudioParam helpers. Never assign .value on live params.

export function glide(ctx, param, value, tc = 0.01) {
  const now = ctx.currentTime;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
  param.setTargetAtTime(value, now, tc);
}

export function ramp(ctx, param, value, sec = 0.005) {
  const now = ctx.currentTime;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
  param.linearRampToValueAtTime(value, now + sec);
}
