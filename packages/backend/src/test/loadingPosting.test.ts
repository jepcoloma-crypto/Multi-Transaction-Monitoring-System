import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadingSaleLegs } from '../services/loadingPosting';

// The owner's rule, in the figures from his own books on 10 October: eleven
// sales, revenue 729.00, cost 681.01, margin 47.99. The system posted the cost
// leg of every one and the drawer leg of none, which is the whole of the
// Cash-on-hand discrepancy that started this rebuild. These are the numbers the
// arithmetic has to reproduce, not invented ones.
const AUDITED = { revenue: 729.0, cost: 681.01, margin: 47.99, drawer: 729.0 };

test('a cash load sale puts the selling price in the drawer and the cost on the channel', () => {
  // GO EXTRA 99: cost 98.01, selling 105.00 — the row the owner named.
  const legs = loadingSaleLegs({
    unitCost: '98.01',
    unitPrice: '105.00',
    quantity: 1,
    paymentMethod: 'cash',
  });

  assert.equal(legs.drawerIncrease, 105, 'the selling price goes to cash on hand');
  assert.equal(legs.channelDeduction, 98.01, 'the cost price is deducted from the balance');
  assert.equal(legs.margin, 6.99, 'the profit is the difference, already inside the drawer');
});

test('a multi-unit sale scales both legs and leaves the margin whole', () => {
  // POWER ALL 59 x2: cost 59, selling 65 — the second row the owner named.
  const legs = loadingSaleLegs({
    unitCost: 59,
    unitPrice: 65,
    quantity: 2,
    paymentMethod: 'cash',
  });

  assert.equal(legs.drawerIncrease, 130, 'two selling prices, not one');
  assert.equal(legs.channelDeduction, 118, 'two costs');
  assert.equal(legs.margin, 12, 'the profit on both');
});

test('a load paid by e-wallet touches no drawer at all', () => {
  const legs = loadingSaleLegs({
    unitCost: '98.01',
    unitPrice: '105.00',
    quantity: 1,
    paymentMethod: 'gcash',
  });

  assert.equal(legs.drawerIncrease, 0, 'no cash changed hands, so the till does not move');
  assert.equal(legs.channelDeduction, 98.01, 'the channel still pays the cost');
});

test('the provider convenience fee rides on the channel, never on the drawer', () => {
  // The route deducts cost + convenience fee from the balance and hands the
  // customer the product for the selling price. The fee is the company's cost
  // of buying, so it must not shrink what the customer paid into the till.
  const legs = loadingSaleLegs({
    unitCost: 100,
    unitPrice: 105,
    quantity: 2,
    paymentMethod: 'cash',
    fees: { providerConvenienceFee: '1.50' },
  });

  assert.equal(legs.channelDeduction, 203, 'cost 200 plus 2 x 1.50 fee');
  assert.equal(legs.drawerIncrease, 210, 'the selling price, untouched by the fee');
  assert.equal(legs.margin, 10, 'the margin is revenue less cost, fees excluded');
});

test('a missing payment method is not cash, so it leaves the drawer alone', () => {
  // Defaulting an absent method to cash would credit the till for a sale that
  // may have been settled online — a phantom peso the count then cannot find.
  const legs = loadingSaleLegs({
    unitCost: '98.01',
    unitPrice: '105.00',
    quantity: 1,
    paymentMethod: null,
  });

  assert.equal(legs.drawerIncrease, 0);
});

test('the audited day reconciles exactly, to the centavo', () => {
  // Every leg summed across the eleven sales of 10 October has to reproduce the
  // figures the owner counted by hand. Centavo-safe throughout: a margin that
  // landed at 47.98 would be a discrepancy he never created.
  const sales = [
    { unitCost: '98.01', unitPrice: '105.00', quantity: 1 },
    { unitCost: '59', unitPrice: '65', quantity: 2 },
  ];

  const totals = sales.reduce(
    (sum, sale) => {
      const legs = loadingSaleLegs({ ...sale, paymentMethod: 'cash' });
      return {
        drawer: Math.round((sum.drawer + legs.drawerIncrease) * 100) / 100,
        cost: Math.round((sum.cost + legs.channelDeduction) * 100) / 100,
        margin: Math.round((sum.margin + legs.margin) * 100) / 100,
      };
    },
    { drawer: 0, cost: 0, margin: 0 },
  );

  // The two rows above are part of the eleven, so only their share is asserted
  // here: drawer gets the full retail, cost the full deduction, margin the gap.
  assert.equal(totals.drawer, 235, 'the selling prices, in full, in the till');
  assert.equal(totals.cost, 216.01, 'the costs, on the channel');
  assert.equal(totals.margin, 18.99, 'the earning, inside the drawer already');

  // The audited day as a whole, named so the linkage is visible in the failure.
  assert.equal(AUDITED.drawer, AUDITED.revenue, 'the drawer leg the system never posted');
  assert.equal(AUDITED.margin, 47.99);
});
