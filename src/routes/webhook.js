const express = require('express');
const { processCommand } = require('../bot');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const update = req.body;

    // Always return 200 OK immediately
    res.status(200).json({ ok: true });

    // Process command asynchronously
    if (update.message || update.channel_post) {
      setImmediate(() => {
        processCommand(update).catch(err => console.error('Command processing error:', err));
      });
    }
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).json({ ok: true });
  }
});

module.exports = router;
