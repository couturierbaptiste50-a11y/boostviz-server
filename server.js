const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const SMM_API_URL   = 'https://my.smm-panel.com/api/v2';
const SMM_API_KEY   = process.env.SMM_API_KEY   || 'TA_CLE_API_ICI';
const SECRET_TOKEN  = process.env.SECRET_TOKEN  || 'boostviz_secret_2026';

// IDs principaux uniquement — pas de secours automatique pour éviter les frais surprises
const SERVICE_IDS = {
  'insta-abo':    process.env.SERVICE_INSTA_ABO    || '4',
  'insta-likes':  process.env.SERVICE_INSTA_LIKES  || '247',
  'insta-story':  process.env.SERVICE_INSTA_STORY  || '123',
  'tiktok-abo':   process.env.SERVICE_TIKTOK_ABO   || '41',
  'tiktok-likes': process.env.SERVICE_TIKTOK_LIKES || '49',
};

// ═══════════════════════════════════════════
// FONCTION — Récupérer les infos d'un service (pour vérifier s'il est dispo)
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
    if (!Array.isArray(services)) return { available: false, reason: 'Impossible de récupérer la liste des services' };

    const found = services.find(s => String(s.service) === String(serviceId));
    if (!found) return { available: false, reason: 'Service ID ' + serviceId + ' introuvable sur le panel' };

    // Vérifier si le service est actif (certains panels ont un champ "status")
    if (found.status && found.status.toLowerCase() === 'disabled') {
      return { available: false, reason: 'Service désactivé sur le panel' };
    }

    return { available: true, service: found };
  } catch (err) {
    return { available: false, reason: 'Erreur réseau: ' + err.message };
  }
}

// ═══════════════════════════════════════════
// FONCTION — Envoyer une commande au SMM panel
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
// ROUTE PRINCIPALE — Commande avec vérification avant envoi
// ═══════════════════════════════════════════
app.post('/order', async (req, res) => {
  const { token, service, link, quantity, customerEmail, customerName } = req.body;

  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
  if (!service || !link || !quantity) return res.status(400).json({ error: 'Champs manquants' });

  const serviceId = SERVICE_IDS[service];
  if (!serviceId) return res.status(400).json({ error: 'Service inconnu: ' + service });

  console.log('\n📦 Nouvelle commande reçue:');
  console.log('   Client: ' + customerName + ' (' + customerEmail + ')');
  console.log('   Service: ' + service + ' (ID ' + serviceId + ')');
  console.log('   Lien: ' + link);
  console.log('   Quantité: ' + quantity);

  try {
    // ── Étape 1 : Vérifier si le service est disponible ──
    console.log('   🔍 Vérification disponibilité service ID ' + serviceId + '...');
    const check = await checkServiceAvailable(serviceId);

    if (!check.available) {
      // Service indispo → mettre en attente sans débiter
      console.warn('   ⏳ Service indisponible: ' + check.reason);
      console.warn('   → Commande mise en ATTENTE MANUELLE');
      return res.status(202).json({
        success: false,
        status: 'pending_manual',
        reason: check.reason,
        message: 'Service temporairement indisponible. Commande enregistrée en attente.',
      });
    }

    // ── Étape 2 : Service dispo → envoyer la commande ──
    console.log('   ✅ Service disponible! Envoi de la commande...');
    const data = await sendSMMOrder(serviceId, link, quantity);

    if (data.order) {
      console.log('   🚀 Commande SMM lancée! ID #' + data.order);
      return res.json({
        success: true,
        status: 'processing',
        orderId: data.order,
        serviceId: serviceId,
      });
    }

    // ── Erreur retournée par le panel ──
    console.error('   ❌ Erreur SMM panel: ' + JSON.stringify(data));
    return res.status(202).json({
      success: false,
      status: 'pending_manual',
      reason: data.error || 'Erreur inconnue du panel',
      message: 'Erreur panel SMM. Commande enregistrée en attente.',
    });

  } catch (err) {
    console.error('   ❌ Erreur réseau: ' + err.message);
    return res.status(202).json({
      success: false,
      status: 'pending_manual',
      reason: 'Erreur réseau: ' + err.message,
      message: 'Erreur de connexion. Commande enregistrée en attente.',
    });
  }
});

// ═══════════════════════════════════════════
// ROUTE — Statut d'une commande SMM
// ═══════════════════════════════════════════
app.get('/status/:orderId', async (req, res) => {
  const { token } = req.query;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const params = new URLSearchParams({ key: SMM_API_KEY, action: 'status', order: req.params.orderId });
    const r = await fetch(SMM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return res.json(await r.json());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// ROUTE — Solde SMM
// ═══════════════════════════════════════════
app.get('/balance', async (req, res) => {
  const { token } = req.query;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const params = new URLSearchParams({ key: SMM_API_KEY, action: 'balance' });
    const r = await fetch(SMM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return res.json(await r.json());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// DEMARRAGE
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 BoostViz API démarrée sur port ' + PORT);
  console.log('Services configurés:');
  Object.entries(SERVICE_IDS).forEach(([k, v]) => console.log('  ' + k + ' → ID ' + v));
});
