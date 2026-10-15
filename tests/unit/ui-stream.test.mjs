// UI → engine visibility report: the engine slows the stream to pages that are hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUiMessage } from '../../shared/protocol.js';

test('validateUiMessage accepts {t:"vis", hidden:boolean} only', () => {
  assert.deepEqual(validateUiMessage({ t: 'vis', hidden: true }), { ok: true });
  assert.deepEqual(validateUiMessage({ t: 'vis', hidden: false }), { ok: true });
  for (const m of [{ t: 'vis' }, { t: 'vis', hidden: 'yes' }, { t: 'vis', hidden: 1 }, { t: 'vis', hidden: null }]) {
    assert.equal(validateUiMessage(m).ok, false, JSON.stringify(m));
  }
});
