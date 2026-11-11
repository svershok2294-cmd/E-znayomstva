import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVipPayments } from './vip-payments.js';

test('VIP requires verified payment and records a charge exactly once', async () => {
  const docs = new Map([
    ['ez_users/101', { name: 'Fixture' }],
    ['ez_users/202', { name: 'Fixture' }],
    ['ez_users/303', { isBanned: true }]
  ]);
  const snapshot = ref => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  const db = {
    collection: name => ({ doc: id => ({
      id,
      path: name + '/' + id,
      async get() { return snapshot(this); },
      async create(value) { assert.ok(!docs.has(this.path)); docs.set(this.path, value); }
    }) }),
    async runTransaction(operation) {
      const writes = [];
      const tx = {
        getAll: async (...refs) => refs.map(snapshot),
        create: (ref, value) => writes.push(() => { assert.ok(!docs.has(ref.path)); docs.set(ref.path, value); }),
        update: (ref, value) => writes.push(() => { assert.ok(docs.has(ref.path)); docs.set(ref.path, { ...docs.get(ref.path), ...value }); }),
        set: (ref, value) => writes.push(() => docs.set(ref.path, value))
      };
      const result = await operation(tx);
      writes.forEach(write => write());
      return result;
    }
  };
  let time = 100_000;
  const calls = [];
  const vip = createVipPayments(db, async (method, args) => {
    calls.push({ method, args });
    return method === 'createInvoiceLink' ? 'https://t.me/test_invoice' : true;
  }, () => time);

  assert.equal(await vip.createInvoice('303'), null);
  assert.equal(await vip.createInvoice('101'), 'https://t.me/test_invoice');
  const invoice = calls.at(-1).args;
  assert.equal(invoice.currency, 'XTR');
  assert.equal(invoice.prices[0].amount, 149);
  const query = { id: 'checkout', from: { id: 101 }, currency: 'XTR', total_amount: 149, invoice_payload: invoice.payload };
  for (const change of [{ from: { id: 202 } }, { total_amount: 1 }, { currency: 'USD' }]) {
    await vip.handleUpdate({ pre_checkout_query: { ...query, ...change } });
    assert.equal(calls.at(-1).args.ok, false);
  }
  const receipt = { message: { from: { id: 101 }, successful_payment: { ...query, telegram_payment_charge_id: 'charge-1' } } };
  await assert.rejects(vip.handleUpdate(receipt), /Unapproved/);
  await vip.handleUpdate({ pre_checkout_query: query });
  assert.equal(calls.at(-1).args.ok, true);
  assert.equal(docs.has('ez_vip_entitlements/101'), false);
  await vip.handleUpdate({ pre_checkout_query: { ...query, id: 'different-checkout' } });
  assert.equal(calls.at(-1).args.ok, false);
  await vip.handleUpdate(receipt);
  const expiry = time + 30 * 24 * 60 * 60 * 1000;
  assert.equal(docs.get('ez_users/101').vipUntil, expiry);
  assert.equal(docs.get('ez_vip_entitlements/101').vipUntil, expiry);
  time += 100;
  await vip.handleUpdate(receipt);
  assert.equal(docs.get('ez_vip_entitlements/101').vipUntil, expiry);
  assert.equal([...docs.keys()].filter(key => key.startsWith('ez_vip_charges/')).length, 1);

  await vip.createInvoice('101');
  const expired = calls.at(-1).args.payload;
  time += 16 * 60 * 1000;
  await vip.handleUpdate({ pre_checkout_query: { ...query, invoice_payload: expired } });
  assert.equal(calls.at(-1).args.ok, false);
});
