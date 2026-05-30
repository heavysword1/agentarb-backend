const express = require('express');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/', async (req, res) => {
  try {
    const { chat_id, min_pct = 0.5, sports = true, predictions = true } = req.query;

    if (!chat_id) {
      return res.status(400).json({ success: false, error: 'chat_id required' });
    }

    // Parse boolean strings
    const sportsBool = sports === 'true' || sports === '1' || sports === true;
    const predictionsBool = predictions === 'true' || predictions === '1' || predictions === true;

    const { data: existing } = await supabase
      .from('arb_alerts_subscribers')
      .select('*')
      .eq('telegram_chat_id', chat_id.toString())
      .single()
      .catch(() => ({ data: null }));

    let subscriber;
    if (existing) {
      const { data } = await supabase
        .from('arb_alerts_subscribers')
        .update({
          min_arb_pct: parseFloat(min_pct),
          sports: sportsBool,
          predictions: predictionsBool,
          active: true
        })
        .eq('telegram_chat_id', chat_id.toString())
        .select()
        .single();
      subscriber = data;
    } else {
      const { data } = await supabase
        .from('arb_alerts_subscribers')
        .insert([
          {
            telegram_chat_id: chat_id.toString(),
            min_arb_pct: parseFloat(min_pct),
            sports: sportsBool,
            predictions: predictionsBool,
            active: true
          }
        ])
        .select()
        .single();
      subscriber = data;
    }

    res.json({
      success: true,
      subscriber_id: subscriber.id,
      message: 'Subscribed! Start @AgentArbBot on Telegram and send /start'
    });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
