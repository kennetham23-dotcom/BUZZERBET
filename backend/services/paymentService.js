const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');
const logger = require('../config/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTN MOBILE MONEY ─────────────────────────────────────────────────────────
const mtnCollection = axios.create({
  baseURL: process.env.MTN_BASE_URL,
  headers: { 'Ocp-Apim-Subscription-Key': process.env.MTN_COLLECTION_SUBSCRIPTION_KEY },
});
const mtnDisbursement = axios.create({
  baseURL: process.env.MTN_BASE_URL,
  headers: { 'Ocp-Apim-Subscription-Key': process.env.MTN_DISBURSEMENT_SUBSCRIPTION_KEY },
});

async function getMtnCollectionToken() {
  const credentials = Buffer.from(
    `${process.env.MTN_COLLECTION_API_USER}:${process.env.MTN_COLLECTION_API_KEY}`
  ).toString('base64');
  const res = await mtnCollection.post('/collection/token/', {}, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  return res.data.access_token;
}

async function getMtnDisbursementToken() {
  const credentials = Buffer.from(
    `${process.env.MTN_DISBURSEMENT_API_USER}:${process.env.MTN_DISBURSEMENT_API_KEY}`
  ).toString('base64');
  const res = await mtnDisbursement.post('/disbursement/token/', {}, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  return res.data.access_token;
}

async function mtnRequestToPayCollection({ phone, amount, referenceId, note = 'BuzzerBet Deposit' }) {
  const token = await getMtnCollectionToken();
  await mtnCollection.post('/collection/v1_0/requesttopay', {
    amount: String(amount),
    currency: 'GHS',
    externalId: referenceId,
    payer: { partyIdType: 'MSISDN', partyId: phone.replace(/^0/, '233') },
    payerMessage: note,
    payeeNote: note,
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': process.env.MTN_ENVIRONMENT || 'sandbox',
    },
  });
  return referenceId;
}

async function mtnTransferDisbursement({ phone, amount, referenceId, note = 'BuzzerBet Withdrawal' }) {
  const token = await getMtnDisbursementToken();
  await mtnDisbursement.post('/disbursement/v1_0/transfer', {
    amount: String(amount),
    currency: 'GHS',
    externalId: referenceId,
    payee: { partyIdType: 'MSISDN', partyId: phone.replace(/^0/, '233') },
    payerMessage: note,
    payeeNote: note,
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': process.env.MTN_ENVIRONMENT || 'sandbox',
    },
  });
  return referenceId;
}

// ── VODAFONE CASH ────────────────────────────────────────────────────────────
async function getVodafoneToken() {
  const res = await axios.post(`${process.env.VODAFONE_BASE_URL}/oauth/token`, {
    grant_type: 'client_credentials',
    client_id: process.env.VODAFONE_CLIENT_ID,
    client_secret: process.env.VODAFONE_CLIENT_SECRET,
  });
  return res.data.access_token;
}

async function vodafoneCollect({ phone, amount, referenceId }) {
  const token = await getVodafoneToken();
  const res = await axios.post(`${process.env.VODAFONE_BASE_URL}/payments/collect`, {
    merchant_id: process.env.VODAFONE_MERCHANT_ID,
    msisdn: phone,
    amount,
    reference: referenceId,
    description: 'BuzzerBet Deposit',
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function vodafonePayout({ phone, amount, referenceId }) {
  const token = await getVodafoneToken();
  const res = await axios.post(`${process.env.VODAFONE_BASE_URL}/payments/payout`, {
    merchant_id: process.env.VODAFONE_MERCHANT_ID,
    msisdn: phone,
    amount,
    reference: referenceId,
    description: 'BuzzerBet Withdrawal',
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

// ── AIRTELTIGO MONEY ─────────────────────────────────────────────────────────
async function getAirtelToken() {
  const res = await axios.post(`${process.env.AIRTELTIGO_BASE_URL}/auth/oauth2/token`, {
    client_id: process.env.AIRTELTIGO_CLIENT_ID,
    client_secret: process.env.AIRTELTIGO_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  return res.data.access_token;
}

async function airtelCollect({ phone, amount, referenceId }) {
  const token = await getAirtelToken();
  const res = await axios.post(`${process.env.AIRTELTIGO_BASE_URL}/merchant/v2/payments/`, {
    reference: referenceId,
    subscriber: { country: 'GH', currency: 'GHS', msisdn: phone },
    transaction: { amount, country: 'GH', currency: 'GHS', id: referenceId },
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Country': 'GH',
      'X-Currency': 'GHS',
    },
  });
  return res.data;
}

async function airtelPayout({ phone, amount, referenceId }) {
  const token = await getAirtelToken();
  const res = await axios.post(`${process.env.AIRTELTIGO_BASE_URL}/standard/v3/disbursements/`, {
    payee: { msisdn: phone },
    reference: referenceId,
    pin: process.env.AIRTELTIGO_PIN,
    transaction: { amount, id: referenceId, type: 'B2C' },
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Country': 'GH',
      'X-Currency': 'GHS',
    },
  });
  return res.data;
}

// ── STRIPE ───────────────────────────────────────────────────────────────────
async function stripeCreatePaymentIntent({ amount, currency = 'ghs', metadata = {} }) {
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // Stripe uses smallest currency unit
    currency,
    metadata,
    automatic_payment_methods: { enabled: true },
  });
  return { clientSecret: intent.client_secret, intentId: intent.id };
}

async function stripeVerifyWebhook(payload, signature) {
  return stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// ── UNIFIED PAYMENT ROUTER ───────────────────────────────────────────────────
async function initiateDeposit({ provider, phone, amount, userId }) {
  const referenceId = uuidv4();
  logger.info(`Deposit initiated`, { provider, amount, userId, referenceId });

  switch (provider) {
    case 'mtn':
      await mtnRequestToPayCollection({ phone, amount, referenceId });
      return { referenceId, status: 'pending', message: 'Check your MTN MoMo prompt to approve' };
    case 'vodafone':
      await vodafoneCollect({ phone, amount, referenceId });
      return { referenceId, status: 'pending', message: 'Approve the Vodafone Cash request on your phone' };
    case 'airteltigo':
      await airtelCollect({ phone, amount, referenceId });
      return { referenceId, status: 'pending', message: 'Approve the AirtelTigo Money request on your phone' };
    case 'stripe':
      return await stripeCreatePaymentIntent({ amount, metadata: { userId, referenceId } });
    default:
      throw Object.assign(new Error('Unsupported payment provider'), { status: 400 });
  }
}

async function initiateWithdrawal({ provider, phone, amount, userId }) {
  const referenceId = uuidv4();
  logger.info(`Withdrawal initiated`, { provider, amount, userId, referenceId });

  switch (provider) {
    case 'mtn':
      await mtnTransferDisbursement({ phone, amount, referenceId });
      return { referenceId, status: 'pending', message: 'MTN MoMo transfer initiated' };
    case 'vodafone':
      await vodafonePayout({ phone, amount, referenceId });
      return { referenceId, status: 'pending', message: 'Vodafone Cash transfer initiated' };
    case 'airteltigo':
      await airtelPayout({ phone, amount, referenceId });
      return { referenceId, status: 'pending', message: 'AirtelTigo Money transfer initiated' };
    default:
      throw Object.assign(new Error('Card withdrawals not supported. Use mobile money.'), { status: 400 });
  }
}

module.exports = {
  initiateDeposit,
  initiateWithdrawal,
  stripeVerifyWebhook,
};
