// Agenova secure checkout — creates a Stripe Checkout Session.
// The secret key is read from the STRIPE_SECRET_KEY environment variable in Netlify.
// Prices are defined here (server-side) so they can't be tampered with from the page.

const PLANS = {
  month:  { name: 'Agenova 1-Month Starter',      price: 2299 },
  single: { name: 'Agenova 2-Month Supply',       price: 3999 },
  half:   { name: 'Agenova 6-Month Bundle',       price: 7999 },
  year:   { name: 'Agenova Full-Year Bundle',     price: 13999 },
  skin1:  { name: 'Agenova Skin+ (1 bottle)',     price: 2499 },
  skin3:  { name: 'Agenova Skin+ (3 bottles)',    price: 6499 },
  skin6:  { name: 'Agenova Skin+ (6 bottles)',    price: 11999 }
};
const SHIP_KEYS = ['month', 'single', 'skin1'];   // single-bottle tiers pay £4 shipping
const SITE = 'https://agenova-food-supplement.netlify.app';

// turn a nested object into Stripe's bracketed form-encoding
function flatten(obj, prefix, out) {
  out = out || {};
  for (const k in obj) {
    const v = obj[k];
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') flatten(item, `${key}[${i}]`, out);
        else out[`${key}[${i}]`] = item;
      });
    } else if (v && typeof v === 'object') {
      flatten(v, key, out);
    } else if (v !== undefined && v !== null) {
      out[key] = v;
    }
  }
  return out;
}

async function stripe(path, params, key) {
  const body = new URLSearchParams(flatten(params)).toString();
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Stripe error');
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Payment is not configured yet.' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) }; }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const line_items = [];
  let hasShip = false;

  for (const it of items) {
    const p = PLANS[it.key];
    if (!p) continue;
    const qty = Math.max(1, Math.min(20, parseInt(it.qty) || 1));
    if (SHIP_KEYS.includes(it.key)) hasShip = true;
    line_items.push({
      price_data: { currency: 'gbp', unit_amount: p.price, product_data: { name: p.name } },
      quantity: qty
    });
  }
  if (line_items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Your basket is empty.' }) };
  }

  const pct = (payload.subscribe ? 10 : 0) + (payload.loyalty ? 15 : 0);

  const params = {
    mode: 'payment',
    success_url: SITE + '/?paid=1',
    cancel_url: SITE + '/?canceled=1',
    line_items,
    billing_address_collection: 'auto',
    shipping_address_collection: { allowed_countries: ['GB'] }
  };
  if (payload.email) params.customer_email = payload.email;
  if (hasShip) {
    params.shipping_options = [{
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: 'Standard shipping',
        fixed_amount: { amount: 400, currency: 'gbp' }
      }
    }];
  }

  try {
    if (pct > 0) {
      const coupon = await stripe('coupons', { percent_off: pct, duration: 'once', name: 'Agenova discount' }, key);
      params.discounts = [{ coupon: coupon.id }];
    }
    const session = await stripe('checkout/sessions', params, key);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || 'Could not create checkout.' }) };
  }
};
