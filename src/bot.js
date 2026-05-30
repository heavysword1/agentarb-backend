const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BOT_TOKEN = process.env.TELEGRAM_ARB_BOT_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ODDS_KEY = process.env.ODDS_API_KEY;
const SPORTS = ['basketball_nba', 'baseball_mlb', 'americanfootball_nfl', 'icehockey_nhl'];

async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('Error sending Telegram message:', err.message);
  }
}

async function findSportsArbs() {
  const opportunities = [];
  for (const sport of SPORTS) {
    try {
      const { data: games } = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
        params: {
          apiKey: ODDS_KEY,
          regions: 'us',
          markets: 'h2h',
          oddsFormat: 'decimal'
        },
        timeout: 10000
      });

      for (const game of Array.isArray(games) ? games : []) {
        const best = {};
        for (const book of game.bookmakers || []) {
          for (const mkt of book.markets || []) {
            for (const out of mkt.outcomes || []) {
              if (!best[out.name] || out.price > best[out.name].price) {
                best[out.name] = { book: book.title, price: out.price };
              }
            }
          }
        }

        const implied = Object.values(best).reduce((s, o) => s + 1 / o.price, 0);
        if (implied < 1.0) {
          const margin = (1 - implied) * 100;
          opportunities.push({
            sport,
            game: `${game.home_team} vs ${game.away_team}`,
            margin_pct: Math.round(margin * 100) / 100,
            bets: Object.entries(best).map(([team, { book, price }]) => ({
              team,
              book,
              odds: price
            }))
          });
        }
      }
    } catch (e) {
      console.error(`Error fetching ${sport}:`, e.message);
    }
  }
  return opportunities;
}

async function handleStartCommand(chatId, username) {
  const message =
    '🎯 *ArbAlert Bot* - Get notified when sports betting arbitrage opportunities appear!\n\n' +
    '*Commands:*\n' +
    '/subscribe - Subscribe to arb alerts (free)\n' +
    '/unsubscribe - Stop alerts\n' +
    '/status - Your subscription status\n' +
    '/latest - Check for current arb opportunities\n\n' +
    'Powered by x402 on Base mainnet. Data via The Odds API + Polymarket.';

  await sendTelegramMessage(chatId, message);
}

async function handleSubscribeCommand(chatId, username) {
  try {
    const { data: existing } = await supabase
      .from('arb_alerts_subscribers')
      .select('*')
      .eq('telegram_chat_id', chatId.toString())
      .single();

    if (existing) {
      await supabase
        .from('arb_alerts_subscribers')
        .update({ active: true, telegram_username: username })
        .eq('telegram_chat_id', chatId.toString());
    } else {
      await supabase.from('arb_alerts_subscribers').insert([
        {
          telegram_chat_id: chatId.toString(),
          telegram_username: username,
          min_arb_pct: 0.5,
          sports: true,
          predictions: true,
          active: true
        }
      ]);
    }

    await sendTelegramMessage(chatId, '✅ Subscribed! You\'ll receive alerts when arb opportunities > 0.5% are found.');
  } catch (err) {
    console.error('Subscribe error:', err.message);
    await sendTelegramMessage(chatId, '❌ Subscription failed. Please try again.');
  }
}

async function handleUnsubscribeCommand(chatId) {
  try {
    await supabase.from('arb_alerts_subscribers').update({ active: false }).eq('telegram_chat_id', chatId.toString());
    await sendTelegramMessage(chatId, 'Unsubscribed.');
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
  }
}

async function handleStatusCommand(chatId) {
  try {
    const { data: sub } = await supabase
      .from('arb_alerts_subscribers')
      .select('*')
      .eq('telegram_chat_id', chatId.toString())
      .single();

    if (!sub) {
      await sendTelegramMessage(chatId, '❌ Not subscribed. Send /subscribe to enable alerts.');
      return;
    }

    let msg = '📊 *Your Subscription*\n\n';
    msg += `Active: ${sub.active ? '✅' : '❌'}\n`;
    msg += `Min Arb %: ${sub.min_arb_pct}%\n`;
    msg += `Sports Alerts: ${sub.sports ? '✅' : '❌'}\n`;
    msg += `Prediction Alerts: ${sub.predictions ? '✅' : '❌'}\n`;
    if (sub.last_notified) {
      msg += `Last Notified: ${new Date(sub.last_notified).toLocaleString()}\n`;
    }

    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    console.error('Status error:', err.message);
  }
}

async function handleLatestCommand(chatId) {
  try {
    const arbs = await findSportsArbs();

    if (arbs.length === 0) {
      await sendTelegramMessage(chatId, '📊 No arbitrage opportunities found at the moment.');
      return;
    }

    let msg = `🎯 *Found ${arbs.length} Arb Opportunities!*\n\n`;
    for (const arb of arbs.slice(0, 5)) {
      msg += `📊 *${arb.game}*\n`;
      msg += `💰 Guaranteed profit: +${arb.margin_pct}%\n`;
      for (const bet of arb.bets) {
        msg += `  • ${bet.team}: ${bet.odds} @ ${bet.book}\n`;
      }
      msg += '\n';
    }
    if (arbs.length > 5) {
      msg += `_...and ${arbs.length - 5} more. Subscribe for full alerts!_`;
    }

    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    console.error('Latest error:', err.message);
    await sendTelegramMessage(chatId, '❌ Error fetching opportunities. Try again later.');
  }
}

async function processCommand(update) {
  const message = update.message || update.channel_post;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const username = message.from?.username || 'unknown';
  const text = message.text;

  if (text === '/start') {
    await handleStartCommand(chatId, username);
  } else if (text === '/subscribe') {
    await handleSubscribeCommand(chatId, username);
  } else if (text === '/unsubscribe') {
    await handleUnsubscribeCommand(chatId);
  } else if (text === '/status') {
    await handleStatusCommand(chatId);
  } else if (text === '/latest') {
    await handleLatestCommand(chatId);
  }
}

module.exports = { processCommand, findSportsArbs, sendTelegramMessage };
