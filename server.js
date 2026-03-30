const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
}));
app.options('*', cors());

// Body parser — IMPORTANT: raw pour le webhook Stripe
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// CONFIG
const SMM_API_URL    = 'https://my.smm-panel.com/api/v2';
const SMM_API_KEY    = process.env.SMM_API_KEY    || '';
const SECRET_TOKEN   = process.env.SECRET_TOKEN   || 'boostviz_secret_2026';
const FRONTEND_URL   = process.env.FRONTEND_URL   || 'https://boostviz.netlify.app';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const SERVICE_IDS = {
  'insta-abo':    process.env.SERVICE_INSTA_ABO    || '4',
  'insta-likes':  process.env.SERVICE_INSTA_LIKES  || '247',
  'insta-story':  process.env.SERVICE_INSTA_STORY  || '123',
  'tiktok-abo':   process.env.SERVICE_TIKTOK_ABO   || '41',
  'tiktok-likes': process.env.SERVICE_TIKTOK_LIKES || '49',
};

// ═══════════════════════════════════════════
// FONCTION — Vérifier disponibilité service
// ═══════════════════════════════════════════
async function checkServiceAvailable(serviceId) {
  try {
    const params = new URLSearchParams({ key: SMM_API_KEY, action: 'services' });
    const response = await fetch(SMM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const services = await response.json();
    if (!Array.isArray(services)) return { available: false, reason: 'Liste services indisponible' };
    const found = services.find(s => String(s.service) === String(serviceId));
    if (!found) return { available: false, reason: 'Service ID ' + serviceId + ' introuvable' };
    if (found.status && found.status.toLowerCase() === 'disabled') return { available: false, reason: 'Service desactive' };
    return { available: true, service: found };
  } catch (err) {
    return { available: false, reason: 'Erreur: ' + err.message };
  }
}

// ═══════════════════════════════════════════
// FONCTION — Envoyer commande SMM
// ═══════════════════════════════════════════
async function sendSMMOrder(serviceId, link, quantity) {
  const params = new URLSearchParams({
    key: SMM_API_KEY,
    action: 'add',
    service: serviceId,
    link: link,
    quantity: String(quantity),
  });
  const response = await fetch(SMM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return await response.json();
}

// ═══════════════════════════════════════════
// ROUTE SANTE
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'BoostViz API en ligne', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════
// ROUTE — Créer une session Stripe avec montant exact
// ═══════════════════════════════════════════
app.post('/create-checkout', async (req, res) => {
  const { token, service, link, quantity, price, customerEmail, customerName, notes } = req.body;

  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Non autorise' });
  if (!service || !link || !quantity || !price) return res.status(400).json({ error: 'Champs manquants' });

  const serviceId = SERVICE_IDS[service];
  if (!serviceId) return res.status(400).json({ error: 'Service inconnu: ' + service });

  try {
    // Noms lisibles pour Stripe
    const serviceNames = {
      'insta-abo': 'Abonnes Instagram',
      'insta-likes': 'Likes Instagram',
      'insta-story': 'Vues Story Instagram',
      'tiktok-abo': 'Abonnes TikTok',
      'tiktok-likes': 'Likes TikTok',
    };

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: customerEmail || undefined,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'BoostViz — ' + (serviceNames[service] || service),
            description: quantity.toLocaleString('fr-FR') + ' ' + (serviceNames[service] || service) + ' | Livraison < 24h',
          },
          unit_amount: Math.round(price * 100), // Stripe utilise les centimes
        },
        quantity: 1,
      }],
      metadata: {
        service,
        serviceId,
        link,
        quantity: String(quantity),
        customerName: customerName || '',
        notes: notes || '',
      },
      success_url: FRONTEND_URL + '?payment=success',
      cancel_url: FRONTEND_URL + '?payment=cancel',
    });

    console.log('Session Stripe creee: ' + session.id + ' | ' + price + 'EUR | ' + service);
    return res.json({ success: true, checkoutUrl: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Erreur Stripe:', err.message);
    return res.status(500).json({ error: 'Erreur Stripe: ' + err.message });
  }
});

// ═══════════════════════════════════════════
// ROUTE — Webhook Stripe (déclenché après paiement confirmé)
// ═══════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  let event;

  // Vérifier la signature Stripe si webhook secret configuré
  if (WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature invalide:', err.message);
      return res.status(400).json({ error: 'Signature invalide' });
    }
  } else {
    event = req.body;
  }

  // Paiement confirmé
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { service, serviceId, link, quantity, customerName } = session.metadata;

    console.log('\nPaiement confirme par Stripe!');
    console.log('  Client: ' + customerName + ' (' + session.customer_email + ')');
    console.log('  Service: ' + service + ' (ID ' + serviceId + ')');
    console.log('  Lien: ' + link);
    console.log('  Quantite: ' + quantity);

    try {
      // Vérifier disponibilité
      const check = await checkServiceAvailable(serviceId);
      if (!check.available) {
        console.warn('  Service indisponible: ' + check.reason);
        console.warn('  -> Commande mise en attente manuelle');
        return res.json({ received: true, status: 'pending_manual' });
      }

      // Lancer la commande SMM
      const data = await sendSMMOrder(serviceId, link, quantity);
      if (data.order) {
        console.log('  Commande SMM lancee! ID #' + data.order);
      } else {
        console.error('  Erreur SMM:', JSON.stringify(data));
      }
    } catch (err) {
      console.error('  Erreur traitement:', err.message);
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════
// ROUTE — Solde SMM
// ═══════════════════════════════════════════
app.get('/balance', async (req, res) => {
  const { token } = req.query;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Non autorise' });
  try {
    const params = new URLSearchParams({ key: SMM_API_KEY, action: 'balance' });
    const r = await fetch(SMM_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    return res.json(await r.json());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DEMARRAGE
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nBoostViz API demarree sur port ' + PORT);
  console.log('Stripe: ' + (process.env.STRIPE_SECRET_KEY ? 'configure' : 'NON CONFIGURE'));
  console.log('SMM API: ' + (SMM_API_KEY ? 'configure' : 'NON CONFIGURE'));
});
