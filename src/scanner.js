const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
if (!process.env.ODDS_API_KEY) require('dotenv').config({ path: '/root/memoryapi-backend/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BOT_TOKEN = process.env.TELEGRAM_ARB_BOT_TOKEN;
// ODDS_KEY loaded inside function
const SPORTS = ['basketball_nba', 'baseball_mlb', 'americanfootball_nfl', 'icehockey_nhl'];

async function sendTelegramMessage(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  });
}


async function findSportsArbsRundown() {
  const RAPID_KEY = process.env.RAPIDAPI_THERUNDOWN_KEY;
  if (!RAPID_KEY) return findSportsArbs(); // fallback
  
  const HOST = 'therundown-therundown-v1.p.rapidapi.com';
  const TODAY = new Date().toISOString().split('T')[0];
  const SPORTS = [{id:3,name:'MLB'},{id:4,name:'NBA'},{id:6,name:'NHL'},{id:7,name:'MMA'},{id:2,name:'NFL'}];
  const opportunities = [];
  
  for (const sport of SPORTS) {
    try {
      const resp = await axios.get(
        `https://${HOST}/sports/${sport.id}/events/${TODAY}`,
        { headers: {'x-rapidapi-key':RAPID_KEY,'x-rapidapi-host':HOST,'Content-Type':'application/json'}, timeout:10000 }
      );
      const events = resp.data?.events || [];
      
      for (const event of events) {
        const teams = event.teams_normalized || [];
        const home = teams.find(t=>t.is_home)?.name || 'Home';
        const away = teams.find(t=>!t.is_home)?.name || 'Away';
        const lines = event.lines || {};
        const best = {};
        
        for (const [bookId, line] of Object.entries(lines)) {
          const odds = line.moneyline || {};
          const h = odds.moneyline_home, a = odds.moneyline_away;
          if (h && a) {
            const hDec = h > 0 ? 1+(h/100) : 1-(100/h);
            const aDec = a > 0 ? 1+(a/100) : 1-(100/a);
            if (!best.home || hDec > best.home.price) best.home = {book:bookId, price:hDec, team:home};
            if (!best.away || aDec > best.away.price) best.away = {book:bookId, price:aDec, team:away};
          }
        }
        
        if (best.home && best.away) {
          const implied = 1/best.home.price + 1/best.away.price;
          if (implied < 1.0) {
            const margin = (1 - implied) * 100;
            const commenceTime = event.event_date ? new Date(event.event_date) : null;
            const daysUntil = commenceTime ? Math.ceil((commenceTime - new Date()) / (1000*60*60*24)) : null;
            opportunities.push({
              sport: sport.name, 
              game: `${away} vs ${home}`,
              game_date: commenceTime?.toISOString().split('T')[0],
              days_until: daysUntil,
              margin_pct: Math.round(margin * 100) / 100,
              bets: [
                {team: home, book: best.home.book, odds: best.home.price},
                {team: away, book: best.away.book, odds: best.away.price}
              ]
            });
          }
        }
      }
    } catch(e) { console.error(`[TheRundown] ${sport.name} error:`, e.message); }
  }
  return opportunities;
}

async function findSportsArbs() {
  const ODDS_KEY = process.env.ODDS_API_KEY;
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
  const arbs = await findSportsArbsRundown();
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
      const maxDays = sub.days_ahead || 30; // default 30 days
      const relevant = arbs.filter(a => 
        a.margin_pct >= (sub.min_arb_pct || 0.5) &&
        (a.days_until === null || a.days_until <= maxDays)
      );
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
