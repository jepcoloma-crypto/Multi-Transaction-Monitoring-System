const http = require('http');

const BASE = 'http://localhost:3001/api';
let token = '';
let passed = 0;
let failed = 0;

function request(method, path, body = null, auth = true) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}${path}`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data, raw: true });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name} ${detail ? '- ' + detail : ''}`);
  }
}

async function runTests() {
  console.log('\n=== Authentication Tests ===');

  const login = await request('POST', '/auth/login', { email: 'admin@example.com', password: 'password' }, false);
  assert('Login returns token', login.status === 200 && login.data.data?.accessToken);
  token = login.data.data.accessToken;

  const me = await request('GET', '/auth/me');
  assert('GET /me returns user', me.status === 200 && me.data.data?.email === 'admin@example.com');

  console.log('\n=== Account Tests ===');

  const accounts = await request('GET', '/accounts');
  assert('GET /accounts returns data', accounts.status === 200);
  const accList = accounts.data.data?.data || accounts.data.data;
  assert('Has seeded accounts', Array.isArray(accList) && accList.length >= 1);

  const accountSummary = await request('GET', '/accounts/summary');
  assert('GET /accounts/summary works', accountSummary.status === 200);

  const balances = await request('GET', '/balances');
  assert('GET /balances returns data', balances.status === 200 && balances.data.data?.totalBalance !== undefined);

  console.log('\n=== Transaction Tests ===');

  const accId = accList[0].id;
  const types = await request('GET', '/transaction-types/types');
  assert('GET /transaction-types/types works', types.status === 200 && Array.isArray(types.data.data));
  const cashInType = types.data.data.find((t) => t.direction === 'in');
  const typeId = cashInType ? cashInType.id : types.data.data[0].id;

  const tx = await request('POST', '/transactions', {
    accountId: accId,
    transactionTypeId: typeId,
    amount: 100,
    fee: 0,
    description: 'Test transaction',
  });
  assert('POST /transactions creates', tx.status === 201 && tx.data.data?.id);

  const txList = await request('GET', '/transactions?limit=5');
  assert('GET /transactions lists', txList.status === 200 && txList.data.data?.data?.length > 0);

  const txSummary = await request('GET', '/transactions/summary');
  assert('GET /transactions/summary works', txSummary.status === 200);

  console.log('\n=== Transfer Tests ===');

  const acc2 = accList.length > 1 ? accList[1].id : accId;
  const transfer = await request('POST', '/transfers', {
    sourceAccountId: accId,
    destinationAccountId: acc2,
    transferAmount: 100,
    transferFee: 10,
    purpose: 'Test transfer',
  });
  assert('POST /transfers creates', transfer.status === 201 && transfer.data.data?.id);

  const transferList = await request('GET', '/transfers');
  assert('GET /transfers lists', transferList.status === 200);

  const transferSummary = await request('GET', '/transfers/summary');
  assert('GET /transfers/summary works', transferSummary.status === 200);

  console.log('\n=== Loading Tests ===');

  const products = await request('GET', '/loading/products');
  assert('GET /loading/products works', products.status === 200);

  const loadingSummary = await request('GET', '/loading/summary');
  assert('GET /loading/summary works', loadingSummary.status === 200);

  console.log('\n=== Reconciliation Tests ===');

  const recons = await request('GET', '/reconciliations');
  assert('GET /reconciliations works', recons.status === 200);

  const recon = await request('POST', '/reconciliations', {
    accountId: accId,
    actualBalance: 47400,
    notes: 'Test reconciliation',
  });
  assert('POST /reconciliations creates', recon.status === 201 && recon.data.data?.id);

  console.log('\n=== Reports Tests ===');

  const consolidated = await request('GET', '/reports/consolidated');
  assert('GET /reports/consolidated works', consolidated.status === 200 && consolidated.data.data?.accounts);

  const txReport = await request('GET', '/reports/transaction-report');
  assert('GET /reports/transaction-report works', txReport.status === 200);

  const transferReport = await request('GET', '/reports/transfer-report');
  assert('GET /reports/transfer-report works', transferReport.status === 200);

  const loadingReport = await request('GET', '/reports/loading-report');
  assert('GET /reports/loading-report works', loadingReport.status === 200);

  const trends = await request('GET', '/reports/balance-trends?days=30');
  assert('GET /reports/balance-trends works', trends.status === 200 && Array.isArray(trends.data.data));

  console.log('\n=== Settings Tests ===');

  const settings = await request('GET', '/settings');
  assert('GET /settings works', settings.status === 200 && settings.data.data?.low_balance_threshold);

  console.log('\n=== Profile Tests ===');

  const profile = await request('GET', '/profile/profile');
  assert('GET /profile/profile works', profile.status === 200 && profile.data.data?.email);

  const activity = await request('GET', '/profile/activity?limit=5');
  assert('GET /profile/activity works', activity.status === 200 && Array.isArray(activity.data.data));

  console.log('\n=== Alert Tests ===');

  const genAlerts = await request('POST', '/alerts/generate');
  assert('POST /alerts/generate works', genAlerts.status === 200 && typeof genAlerts.data.data?.alertsCreated === 'number');

  const alerts = await request('GET', '/alerts');
  assert('GET /alerts works', alerts.status === 200);

  console.log('\n=== Import Tests ===');

  const template = await request('GET', '/import/template/transactions');
  assert('GET /import/template/transactions works', template.status === 200 && template.raw);

  const importTx = await request('POST', '/import/transactions', {
    data: [{ account_id: accId, type_name: 'Cash-In', amount: 999, description: 'Import test' }],
  });
  assert('POST /import/transactions works', importTx.status === 200 && importTx.data.data?.created === 1);

  console.log('\n=== Security Tests ===');

  const noAuth = await request('GET', '/accounts', null, false);
  assert('Unauthenticated request blocked', noAuth.status === 401);

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
