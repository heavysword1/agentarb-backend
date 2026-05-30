const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BOT_TOKEN = process.env.TELEGRAM_ARB_BOT_TOKEN;
const ODDS_KEY = process.env.ODDS_API_KEY;
const SPORTS = ['basketball_nba', 'baseball_mlb', 'americanfootball_nfl', 'icehockey_nhl'];

async function sendTelegramMessage(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  });
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

async function scanAndNotify() {
  console.log('[Scanner] Running arb scan...');
  const arbs = await findSportsArbs();
  if (arbs.length === 0) {
    console.log('[Scanner] No arbs found');
    return;
  }

  console.log(`[Scanner] Found ${arbs.length} arb opportunities!`);

  // Get active subscribers
  const { data: subscribers } = await supabase
    .from('arb_alerts_subscribers')
    .select('*')
    .eq('active', true)
    .eq('sports', true);

  for (const sub of subscribers || []) {
    try {
      const relevant = arbs.filter(a => a.margin_pct >= (sub.min_arb_pct || 0.5));
      if (relevant.length === 0) continue;

      let msg = `🎯 *ArbAlert: ${relevant.length} Opportunity${relevant.length > 1 ? 'ies' : ''} Found!*\n\n`;
      for (const arb of relevant.slice(0, 3)) {
        msg += `📊 *${arb.game}*\n`;
        msg += `💰 Guaranteed profit: +${arb.margin_pct}%\n`;
        for (const bet of arb.bets) {
          msg += `  • ${bet.team}: ${bet.odds} @ ${bet.book}\n`;
        }
        msg += '\n';
      }
      msg += `_Get full details: pay $0.005 at https://predict.memoryapi.org/x402/predict/sports\\_arb_`;

      await sendTelegramMessage(sub.telegram_chat_id, msg);
      await supabase
        .from('arb_alerts_subscribers')
        .update({ last_notified: new Date().toISOString() })
        .eq('id', sub.id);
    } catch (e) {
      console.error('Error notifying subscriber:', sub.telegram_chat_id, e.message);
    }
  }
}

scanAndNotify()
  .then(() => {
    console.log('[Scanner] Done');
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
