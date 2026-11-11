import { randomUUID } from 'node:crypto';

const catalog = [
  { id: 'sparkling', label: '🥂 Ігристе', price: 10 },
  { id: 'peonies', label: '💐 Букет півоній', price: 15 },
  { id: 'crown', label: '♔ Золота корона', price: 20 },
  { id: 'diamond', label: '💎 Діамант', price: 20 },
  { id: 'teddy', label: '🧸 Ведмедик', price: 15 },
  { id: 'checkmate', label: '🔥 Супер-мат', price: 25 }
];
const validUser = id => typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id);
export const isGiftOrder = id => typeof id === 'string' &&
  /^gift-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const validCharge = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !id.includes('/');
const available = snapshot => snapshot.exists && !snapshot.data().isBanned;

export function createGiftPayments(db, telegram, now = Date.now) {
  const orders = db.collection('ez_gift_orders');
  const charges = db.collection('ez_gift_charges');
  const users = db.collection('ez_users');
  const moves = db.collection('ez_moves');

  async function eligible(tx, buyer, recipient) {
    const blocks = db.collection('ez_blocks');
    const [sender, target, blocked, reverse] = await tx.getAll(
      users.doc(buyer), users.doc(recipient),
      blocks.doc(buyer).collection('users').doc(recipient),
      blocks.doc(recipient).collection('users').doc(buyer)
    );
    return available(sender) && available(target) && !blocked.exists && !reverse.exists;
  }

  async function createInvoice(buyer, recipient, giftId) {
    const gift = catalog.find(item => item.id === giftId);
    if (!gift || !validUser(buyer) || !validUser(recipient) || buyer === recipient) return null;
    const orderId = 'gift-' + randomUUID();
    const allowed = await db.runTransaction(async tx => {
      if (!await eligible(tx, buyer, recipient)) return false;
      tx.create(orders.doc(orderId), {
        buyer, recipient, giftId, label: gift.label, price: gift.price,
        expiresAt: now() + 15 * 60 * 1000, status: 'pending'
      });
      return true;
    });
    if (!allowed) return null;
    const invoiceUrl = await telegram('createInvoiceLink', {
      title: gift.label, description: 'Подарунок для іншого користувача в Е — Знайомства.',
      payload: orderId, provider_token: '', currency: 'XTR',
      prices: [{ label: gift.label, amount: gift.price }]
    });
    return { invoiceUrl, orderId };
  }

  function matches(order, buyer, payment) {
    return order.buyer === buyer && payment.currency === 'XTR' && payment.total_amount === order.price;
  }

  async function preCheckout(query) {
    const buyer = String(query.from?.id ?? '');
    const ref = orders.doc(query.invoice_payload);
    const ok = validUser(buyer) && await db.runTransaction(async tx => {
      const saved = await tx.get(ref);
      if (!saved.exists || !matches(saved.data(), buyer, query)) return false;
      const order = saved.data();
      if (order.status === 'approved') return order.checkoutId === query.id;
      if (order.status !== 'pending' || order.expiresAt <= now() || !await eligible(tx, buyer, order.recipient)) return false;
      tx.update(ref, { status: 'approved', checkoutId: query.id });
      return true;
    });
    await telegram('answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id, ok,
      ...(ok ? {} : { error_message: 'Цей подарунок зараз недоступний. Повернись у застосунок.' })
    });
  }

  async function recordRefund(payment) {
    const chargeId = payment.telegram_payment_charge_id;
    if (!validCharge(chargeId) || payment.currency !== 'XTR') return;
    const chargeRef = charges.doc(chargeId);
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(chargeRef);
      if (!snapshot.exists) throw new Error('Gift refund arrived before charge');
      const charge = snapshot.data();
      if (charge.orderId !== payment.invoice_payload || charge.amount !== payment.total_amount) {
        throw new Error('Gift refund mismatch');
      }
      if (charge.status === 'refunded') return;
      if (charge.status === 'delivered') tx.delete(moves.doc(charge.orderId));
      tx.update(chargeRef, { status: 'refunded', refundedAt: now() });
      tx.update(orders.doc(charge.orderId), { status: 'refunded' });
    });
  }

  async function successfulPayment(message) {
    const buyer = String(message.from?.id ?? '');
    const payment = message.successful_payment;
    const chargeId = payment.telegram_payment_charge_id;
    if (!validUser(buyer) || !validCharge(chargeId)) throw new Error('Invalid gift payment');
    const orderRef = orders.doc(payment.invoice_payload);
    const chargeRef = charges.doc(chargeId);
    const refund = await db.runTransaction(async tx => {
      const [saved, charged] = await tx.getAll(orderRef, chargeRef);
      if (charged.exists) {
        const charge = charged.data();
        if (charge.buyer !== buyer || charge.orderId !== orderRef.id) throw new Error('Gift charge conflict');
        return charge.status === 'refund_pending';
      }
      if (!saved.exists || saved.data().status !== 'approved' || !matches(saved.data(), buyer, payment)) {
        throw new Error('Unapproved gift receipt');
      }
      const order = saved.data();
      const canDeliver = await eligible(tx, buyer, order.recipient);
      const status = canDeliver ? 'delivered' : 'refund_pending';
      const paidAt = now();
      tx.create(chargeRef, { buyer, orderId: orderRef.id, amount: order.price, paidAt, status });
      tx.update(orderRef, { status, chargeId });
      if (canDeliver) {
        tx.create(moves.doc(orderRef.id), {
          fromUserId: buyer, targetUserId: order.recipient, giftId: order.giftId,
          myReply: '🎁 Подарунок: ' + order.label, createdAt: paidAt
        });
      }
      return !canDeliver;
    });
    if (refund) {
      await telegram('refundStarPayment', { user_id: Number(buyer), telegram_payment_charge_id: chargeId });
      await recordRefund(payment);
    }
  }

  return {
    catalog,
    createInvoice,
    async getStatus(buyer, id) {
      const snapshot = await orders.doc(id).get();
      return snapshot.exists && snapshot.data().buyer === buyer ? { status: snapshot.data().status } : null;
    },
    async handleUpdate(update) {
      if (update.pre_checkout_query) await preCheckout(update.pre_checkout_query);
      else if (update.message?.successful_payment) await successfulPayment(update.message);
      else if (update.message?.refunded_payment) await recordRefund(update.message.refunded_payment);
    }
  };
}
