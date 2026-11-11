import { randomUUID } from 'node:crypto';

const price = 149;
const duration = 30 * 24 * 60 * 60 * 1000;
const invoiceLifetime = 15 * 60 * 1000;

export function createVipPayments(db, telegram, now = Date.now) {
  const users = db.collection('ez_users');
  const orders = db.collection('ez_vip_orders');
  const charges = db.collection('ez_vip_charges');
  const entitlements = db.collection('ez_vip_entitlements');
  const telegramId = value => String(value ?? '');
  const validId = value => /^[1-9][0-9]{0,15}$/.test(value);
  const orderId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  const available = profile => profile.exists && !profile.data().isBanned;
  const matches = (order, buyer, payment) => order.buyer === buyer &&
    payment.currency === 'XTR' && payment.total_amount === order.price;

  async function createInvoice(buyer) {
    if (!validId(buyer) || !available(await users.doc(buyer).get())) return null;
    const payload = randomUUID();
    await orders.doc(payload).create({ buyer, price, expiresAt: now() + invoiceLifetime, status: 'pending' });
    return telegram('createInvoiceLink', {
      title: 'VIP на 30 днів',
      description: 'Золота рамка анкети на 30 днів. Одноразова покупка.',
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'VIP на 30 днів', amount: price }]
    });
  }

  async function preCheckout(query) {
    const buyer = telegramId(query.from?.id);
    let ok = false;
    if (validId(buyer) && orderId(query.invoice_payload) && typeof query.id === 'string') {
      const ref = orders.doc(query.invoice_payload);
      ok = await db.runTransaction(async tx => {
        const [saved, profile] = await tx.getAll(ref, users.doc(buyer));
        if (!saved.exists || !available(profile)) return false;
        const order = saved.data();
        if (!matches(order, buyer, query)) return false;
        if (order.status === 'approved') return order.checkoutId === query.id;
        if (order.status !== 'pending' || order.expiresAt <= now()) return false;
        tx.update(ref, { status: 'approved', checkoutId: query.id });
        return true;
      });
    }
    await telegram('answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id,
      ok,
      ...(ok ? {} : { error_message: 'Не вдалося підтвердити рахунок. Відкрий застосунок і створи новий.' })
    });
  }

  async function successfulPayment(message) {
    const payment = message.successful_payment;
    const buyer = telegramId(message.from?.id);
    if (!validId(buyer) || !orderId(payment.invoice_payload) ||
        typeof payment.telegram_payment_charge_id !== 'string' || !payment.telegram_payment_charge_id ||
        payment.telegram_payment_charge_id.length > 256 || payment.telegram_payment_charge_id.includes('/')) {
      throw new Error('Invalid VIP payment receipt');
    }
    const orderRef = orders.doc(payment.invoice_payload);
    const chargeRef = charges.doc(payment.telegram_payment_charge_id);
    const entitlementRef = entitlements.doc(buyer);
    const profileRef = users.doc(buyer);
    await db.runTransaction(async tx => {
      const [saved, charge, entitlement, profile] = await tx.getAll(orderRef, chargeRef, entitlementRef, profileRef);
      if (charge.exists) {
        if (charge.data().orderId !== orderRef.id || charge.data().buyer !== buyer) throw new Error('VIP charge conflict');
        return;
      }
      if (!saved.exists || saved.data().status !== 'approved' || !matches(saved.data(), buyer, payment)) {
        throw new Error('Unapproved VIP payment receipt');
      }
      const paidAt = now();
      const vipUntil = Math.max(paidAt, entitlement.data()?.vipUntil || 0) + duration;
      tx.create(chargeRef, { buyer, orderId: orderRef.id, paidAt, amount: payment.total_amount, currency: 'XTR' });
      tx.update(orderRef, { status: 'paid', paidAt, chargeId: chargeRef.id });
      tx.set(entitlementRef, { vipUntil });
      if (profile.exists) tx.update(profileRef, { vipUntil });
    });
  }

  return {
    createInvoice,
    async handleUpdate(update) {
      if (update.pre_checkout_query) await preCheckout(update.pre_checkout_query);
      else if (update.message?.successful_payment) await successfulPayment(update.message);
    }
  };
}
