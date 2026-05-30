const express = require('express');
const { processCommand } = require('../bot');
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    // Validate Telegram webhook secret token
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret) {
      const incoming = req.headers['x-telegram-bot-api-secret-token'];
      if (incoming !== secret) {
        console.warn('[Webhook] Rejected request with invalid secret from:', req.ip);
        return res.status(403).json({ ok: false });
      }
    }

    // Always return 200 OK immediately to Telegram
    res.status(200).json({ ok: true });

    const update = req.body;
    if (update.message || update.channel_post) {
      setImmediate(() => {
        processCommand(update).catch(err => console.error('Command error:', err));
      });
    }
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).json({ ok: true });
  }
});

module.exports = router;
