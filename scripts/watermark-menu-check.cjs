// Offline: use real Telegraf Context without connecting to Telegram or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.BOT_TOKEN = 'offline-test-token';
process.env.SUPER_ADMIN_ID = '1';
process.env.ADMIN_IDS = '2';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-menu-')), 'bot.db');
const { Context } = require('telegraf');
const { WatermarkHandler } = require('../dist/bot/handlers/WatermarkHandler');
const { TelegramBot } = require('../dist/bot');
const app = Object.create(TelegramBot.prototype);
function context(id, callback, text = '🛡️ 水印管理') {
  const from = { id, first_name: 'Test', is_bot: false };
  const message = { message_id: 1, date: 1, chat: { id, type: 'private' }, from, text };
  const calls = [];
  const telegram = {
    sendMessage: async (...args) => { calls.push(['send', ...args]); return { message_id: 2 }; },
    editMessageText: async (...args) => { calls.push(['edit', ...args]); },
    answerCbQuery: async (...args) => { calls.push(['ack', ...args]); }
  };
  const update = callback ? { update_id: 1, callback_query: { id: 'cb', from, chat_instance: '1', data: 'watermark_menu', message } } : { update_id: 1, message };
  return { ctx: new Context(update, telegram, { id: 99, username: 'testbot' }), calls };
}
(async () => {
  for (const id of [1, 2]) {
    for (const callback of [false, true]) {
      for (const text of ['🛡️ 水印管理', '/watermark']) {
        const { ctx, calls } = context(id, callback, text);
        await WatermarkHandler.handleMenu(ctx, { getAllMedia: async scope => { assert.equal(scope, id === 1 ? undefined : 2); return []; } });
        assert(calls.some(x => x[0] === (callback ? 'edit' : 'send')));
        assert.equal(calls.filter(x => x[0] === 'ack').length, callback ? 1 : 0);
      }
    }
  }
  for (const method of ['handleMenu', 'handleConfirm', 'handleStart', 'handleStop']) {
    const { ctx, calls } = context(3, true);
    await WatermarkHandler[method](ctx, { getAllMedia: async () => { throw Error('unauthorized DB access'); } });
    assert(!calls.some(x => x[0] === 'send' || x[0] === 'edit'));
  }
  for (const id of [1, 2, 3]) {
    const { ctx, calls } = context(id, false);
    await app.showKeywordsPage(ctx, ['11'], 0);
    const rows = calls[0][3].reply_markup.inline_keyboard;
    const wm = rows.findIndex(row => row.some(b => b.callback_data === 'watermark_menu'));
    if (id === 3) assert.equal(wm, -1);
    else {
      assert.equal(wm, rows.length - 2);
      assert(rows[wm - 1].some(b => b.callback_data === 'start_review'));
      assert(rows[wm - 1].some(b => b.callback_data === 'start_tag_filter'));
      assert.equal(rows[wm + 1][0].callback_data, 'back_to_main');
    }
    const main = await app.getCoreFunctionKeyboard(id);
    assert(!JSON.stringify(main).includes('水印管理'));
  }
  console.log('PASS: real message/command/callback contexts, admin scope, unauthorized actions, button order and visibility');
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
