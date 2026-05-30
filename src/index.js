require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { bazaarResourceServerExtension } = require('@x402/extensions');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { HTTPFacilitatorClient } = require('@x402/core/server');

const webhookRouter = require('./routes/webhook');
const subscribeRouter = require('./routes/subscribe');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3031;
const PAY_TO = process.env.PAY_TO_ADDRESS || '0x24FAcafEB49b4e3FACF0B3e69604A2F4640c9bf2';
const X402_NETWORK = process.env.X402_NETWORK || 'eip155:8453';
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'agentarb', port: PORT }));
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: 'https://arb.memoryapi.org',
    authorization_servers: [],
    bearer_methods_supported: [],
    resource_documentation: 'https://memoryapi.org'
  });
});
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.status(404).json({ error: 'No OAuth required.' });
});

// Free webhook endpoint (no x402)
app.post('/webhook', webhookRouter);

try {
  const { createFacilitatorConfig } = require('@coinbase/x402');
  const rawConfig = createFacilitatorConfig(process.env.CDP_API_KEY_NAME, process.env.CDP_API_KEY_PRIVATE_KEY);
  const facilitatorClient = new HTTPFacilitatorClient({
    url: rawConfig.url,
    createAuthHeaders: rawConfig.createAuthHeaders
  });
  const x402Server = new x402ResourceServer(facilitatorClient)
    .register(X402_NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  app.use(
    paymentMiddleware(
      {
        'GET /x402/arb/subscribe': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: X402_NETWORK, payTo: PAY_TO }],
          description: 'Subscribe to ArbAlert with custom settings (minimum arb %, sports, predictions)',
          extensions: {
            bazaar: {
              info: {
                description: 'ArbAlert Bot subscription service for sports betting arbitrage opportunities and prediction market alerts.',
                input: {
                  type: 'http',
                  method: 'GET',
                  queryParams: {
                    chat_id: '123456789',
                    min_pct: '0.5',
                    sports: 'true',
                    predictions: 'true'
                  },
                  schema: {
                    properties: {
                      chat_id: {
                        type: 'string',
                        description: 'Your Telegram chat ID'
                      },
                      min_pct: {
                        type: 'string',
                        description: 'Minimum arbitrage percentage threshold (default 0.5)'
                      },
                      sports: {
                        type: 'string',
                        description: 'Enable sports betting alerts (true/false)'
                      },
                      predictions: {
                        type: 'string',
                        description: 'Enable prediction market alerts (true/false)'
                      }
                    },
                    required: ['chat_id']
                  }
                },
                output: {
                  example: {
                    success: true,
                    subscriber_id: 'uuid-here',
                    message: 'Subscribed! Start @AgentArbBot on Telegram and send /start'
                  }
                }
              }
            }
          }
        }
      },
      x402Server,
      { afterSettle: (req, res, next, s) => {
        const e = s?.extensionResponses;
        if (e) console.log('[CDP] EXTENSION-RESPONSES:', JSON.stringify(e));
        next();
      } },
      null,
      true
    )
  );

  console.log('✅ x402 payment middleware registered');
} catch (err) {
  console.warn('⚠️  x402 middleware skipped:', err.message);
}

app.use('/x402/arb/subscribe', subscribeRouter);

app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'ArbAlert API',
      version: '1.0.0',
      description: 'Sports betting arbitrage and prediction market alerts'
    },
    servers: [{ url: 'https://arb.memoryapi.org' }],
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          responses: { 200: { description: 'Service is healthy' } }
        }
      },
      '/x402/arb/subscribe': {
        get: {
          summary: 'Subscribe to ArbAlert (requires payment)',
          parameters: [
            { name: 'chat_id', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'min_pct', in: 'query', schema: { type: 'number', default: 0.5 } },
            { name: 'sports', in: 'query', schema: { type: 'boolean', default: true } },
            { name: 'predictions', in: 'query', schema: { type: 'boolean', default: true } }
          ],
          responses: { 200: { description: 'Subscription successful' } }
        }
      }
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 AgentArb running on port ${PORT}`);
});

// Register Telegram webhook on startup
setTimeout(async () => {
  try {
    const { data } = await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_ARB_BOT_TOKEN}/setWebhook`,
      {
        url: 'https://arb.memoryapi.org/webhook'
      }
    );
    console.log('📡 Webhook set:', data.description);
  } catch (e) {
    console.error('⚠️  Webhook error:', e.message);
  }
}, 3000);
