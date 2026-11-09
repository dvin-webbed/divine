// Scroll-reveal
const revealEls = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.15 });
revealEls.forEach(el => io.observe(el));

// Mobile nav toggle
const burger = document.querySelector('.burger');
const navMenu = document.querySelector('.primary-nav');
if (burger && navMenu) {
  burger.addEventListener('click', () => {
    const open = navMenu.style.display === 'flex';
    navMenu.style.display = open ? 'none' : 'flex';
    navMenu.style.flexDirection = 'column';
    navMenu.style.position = 'absolute';
    navMenu.style.top = '78px';
    navMenu.style.left = '0';
    navMenu.style.right = '0';
    navMenu.style.background = '#0B0B0C';
    navMenu.style.padding = '10px 28px 20px';
    navMenu.style.borderBottom = '1px solid rgba(243,238,227,.08)';
  });
}

// Soft cross-fade when navigating to another internal page
document.querySelectorAll('a[href$=".html"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    if (link.target === '_blank' || href.startsWith('http') || link.classList.contains('referral-trigger') || link.textContent.trim().toLowerCase() === 'refer a friend') return;
    e.preventDefault();
    document.body.style.transition = 'opacity .28s ease';
    document.body.style.opacity = '0';
    setTimeout(() => { window.location.href = href; }, 240);
  });
});

// Onboarding: goal picker + progress bar (get-started.html only)
document.querySelectorAll('.goal-pick').forEach(card => {
  card.addEventListener('click', () => {
    card.parentElement.querySelectorAll('.goal-pick').forEach(c => c.classList.remove('picked'));
    card.classList.add('picked');
  });
});

// ============ API layer ============
const API_BASE = '/api';

async function apiPost(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.status = res.status;
    throw error;
  }
  return data;
}

async function apiGet(path, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.status = res.status;
    throw error;
  }
  return data;
}

const publicTierLists = document.querySelectorAll('[data-tier-cards]');
if (publicTierLists.length) {
  apiGet('/v1/investments/tiers').then(({ tiers }) => {
    if (!Array.isArray(tiers) || !tiers.length) return;
    const currency = amount => amount.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    const tierMarkup = tiers.map(tier => {
      const range = tier.maxPrincipal === null
        ? `${currency(tier.minPrincipal)} and above`
        : `${currency(tier.minPrincipal)} to ${currency(tier.maxPrincipal)}`;
      return `<article class="way-card">
        <span class="tag-label">${range}</span>
        <h3>${tier.monthlyRatePercent}% monthly</h3>
        <p>At ${currency(tier.minPrincipal)}, estimated monthly profit is ${currency(tier.monthlyProfitAtMinimum)}.</p>
      </article>`;
    }).join('');

    publicTierLists.forEach(list => { list.innerHTML = tierMarkup; });
    document.querySelectorAll('[data-tier-rate-range]').forEach((element, index) => {
      element.textContent = index === 0
        ? `${tiers[0].monthlyRatePercent}% to ${tiers[tiers.length - 1].monthlyRatePercent}%`
        : `${tiers[0].monthlyRatePercent}%–${tiers[tiers.length - 1].monthlyRatePercent}%`;
    });
    document.querySelectorAll('[data-tier-rate-index]').forEach(element => {
      const tier = element.dataset.tierRateIndex === 'last'
        ? tiers[tiers.length - 1]
        : tiers[Number(element.dataset.tierRateIndex)];
      if (tier) element.textContent = `${tier.monthlyRatePercent}%`;
    });
  }).catch(error => console.warn('Configured rate tiers unavailable; showing default copy.', error));
}

function getToken() { return localStorage.getItem('bp_token'); }
function setSession(token, user) {
  localStorage.setItem('bp_token', token);
  localStorage.setItem('bp_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('bp_token');
  localStorage.removeItem('bp_user');
}

// Authenticated users should never be sent back through public onboarding.
const activeToken = getToken();
const currentPage = window.location.pathname.split('/').pop() || 'index.html';
if (activeToken && (currentPage === 'get-started.html' || currentPage === 'login.html')) {
  window.location.replace('dashboard.html');
}

if (activeToken) {
  document.querySelectorAll('a[href*="get-started.html"]').forEach(link => {
    link.href = 'dashboard.html';
    if (/get started|start the intake|build your portfolio|open an account|add .* to your mix/i.test(link.textContent)) {
      link.textContent = 'Go to dashboard';
    }
  });
  document.querySelectorAll('.nav-actions a.btn').forEach(link => link.remove());
}

// ============ Signup form (get-started.html) ============
const onboardForm = document.getElementById('onboard-form');
if (onboardForm) {
  const contactInput = document.getElementById('field-contact');
  const verificationPanel = document.getElementById('signup-verification');
  const verificationForm = document.getElementById('signup-verification-form');
  const verificationCode = document.getElementById('signup-verification-code');
  const verificationDestination = document.getElementById('signup-verification-destination');
  const verifyButton = document.getElementById('signup-verify-submit');
  const resendButton = document.getElementById('signup-resend');
  const changeContactButton = document.getElementById('signup-change-contact');
  const errorBox = document.getElementById('onboard-error');
  let challengeId = null;
  let signupContact = '';

  onboardForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('field-name').value;
    const contact = contactInput.value.trim();
    const password = document.getElementById('field-password').value;
    const referral_code = new URLSearchParams(window.location.search).get('ref');
    const goalEl = onboardForm.querySelector('.goal-pick.picked');
    const goal = goalEl ? goalEl.textContent.trim() : null;
    const investment_term = document.getElementById('field-investment-term').value;
    const submitBtn = document.getElementById('onboard-submit');

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending code…';

    try {
      const result = await apiPost('/auth/signup', {
        name,
        channel: 'email',
        contact,
        password,
        goal,
        investment_term,
        referral_code,
      });
      challengeId = result.challengeId;
      signupContact = contact;
      verificationDestination.textContent = `We sent a six-digit code to ${contact}. It expires in 15 minutes.`;
      onboardForm.style.display = 'none';
      verificationPanel.style.display = 'block';
      verificationCode.focus();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send verification code';
    }
  });

  verificationForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    verifyButton.disabled = true;
    verifyButton.textContent = 'Verifying…';
    try {
      const { token, user } = await apiPost('/auth/signup/verify', {
        challengeId,
        code: verificationCode.value.trim(),
      });
      setSession(token, user);
      window.location.href = 'dashboard.html';
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    } finally {
      verifyButton.disabled = false;
      verifyButton.textContent = 'Verify and create account';
    }
  });

  resendButton.addEventListener('click', async () => {
    errorBox.style.display = 'none';
    resendButton.disabled = true;
    try {
      await apiPost('/auth/signup/resend', { challengeId });
      errorBox.textContent = 'A new verification code has been sent.';
      errorBox.style.display = 'block';
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    } finally {
      resendButton.disabled = false;
    }
  });

  changeContactButton.addEventListener('click', () => {
    challengeId = null;
    verificationCode.value = '';
    contactInput.value = signupContact;
    verificationPanel.style.display = 'none';
    onboardForm.style.display = '';
    errorBox.style.display = 'none';
  });
}

// ============ Login form (login.html) ============
const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = document.getElementById('login-identifier').value;
    const password = document.getElementById('login-password').value;
    const errorBox = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit');

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
      const { token, user } = await apiPost('/auth/login', { identifier, password });
      setSession(token, user);
      window.location.href = 'dashboard.html';
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
    }
  });
}

// ============ Dashboard (dashboard.html) ============
const dashboardRoot = document.getElementById('dashboard-root');
if (dashboardRoot) {
  const token = getToken();
  const depositMethodControl = document.getElementById('deposit-method');
  const withdrawMethodControl = document.getElementById('withdraw-method');
  const cryptoDepositPanel = document.getElementById('crypto-deposit-info');
  const withdrawUsdtPanel = document.getElementById('withdraw-usdt-picker');
  const syncCryptoDepositPanel = () => {
    const showWallet = depositMethodControl?.value === 'crypto';
    if (cryptoDepositPanel) {
      cryptoDepositPanel.hidden = !showWallet;
      cryptoDepositPanel.style.display = showWallet ? 'grid' : 'none';
    }
  };
  if (depositMethodControl && cryptoDepositPanel) {
    depositMethodControl.addEventListener('change', syncCryptoDepositPanel);
    syncCryptoDepositPanel();
  }
  const syncWithdrawMethodPanel = () => {
    const isCrypto = withdrawMethodControl?.value === 'crypto';
    if (withdrawUsdtPanel) withdrawUsdtPanel.hidden = !isCrypto;
  };
  if (withdrawMethodControl && withdrawUsdtPanel) {
    withdrawMethodControl.addEventListener('change', syncWithdrawMethodPanel);
    syncWithdrawMethodPanel();
  }

  const bankDirectoryPickers = ['deposit', 'withdraw'].map(prefix => ({
    prefix,
    country: document.getElementById(`${prefix}-bank-country`),
    search: document.getElementById(`${prefix}-bank-search`),
    results: document.getElementById(`${prefix}-bank-results`),
    note: document.getElementById(`${prefix}-bank-note`),
    panel: document.getElementById(`${prefix}-bank-picker`),
    method: document.getElementById(`${prefix}-method`),
  }));

  function setBankPickerOptions(picker, banks, placeholder) {
    picker.results.replaceChildren(new Option(placeholder, ''));
    banks.forEach(bank => picker.results.add(new Option(bank.name, bank.id)));
    picker.results.disabled = banks.length === 0;
  }

  function setupBankDirectory(directory) {
    const hasValidEnvironment = Boolean(directory?.environment);
    const isConfigured = directory?.configured && hasValidEnvironment;
    bankDirectoryPickers.forEach(picker => {
      picker.panel.hidden = picker.method.value !== 'ach';
      picker.country.replaceChildren(new Option('Choose a country', ''));
      (directory?.countries || []).forEach(country => {
        picker.country.add(new Option(country.name, country.code));
      });
      picker.country.disabled = !isConfigured;
      picker.search.disabled = !isConfigured;
      picker.note.textContent = isConfigured
        ? `Plaid ${directory.environment} directory. Search results depend on provider country access.`
        : !directory?.configured
          ? 'Bank directory unavailable until Plaid credentials are configured.'
          : 'Bank directory unavailable because PLAID_ENV is invalid.';
      setBankPickerOptions(picker, [], isConfigured ? 'Search for a bank' : 'Directory unavailable');

      let searchTimer;
      picker.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const query = picker.search.value.trim();
        if (query.length < 2) {
          setBankPickerOptions(picker, [], 'Enter at least 2 characters');
          return;
        }
        searchTimer = setTimeout(async () => {
          const countryCode = picker.country.value;
          if (!countryCode) {
            setBankPickerOptions(picker, [], 'Choose a country first');
            return;
          }
          picker.results.disabled = true;
          picker.note.textContent = 'Searching current provider directory…';
          try {
            const params = new URLSearchParams({ country_code: countryCode, query });
            const { banks } = await apiGet(`/payments/banks?${params}`, token);
            setBankPickerOptions(picker, banks, banks.length ? 'Choose a bank' : 'No matching banks');
            picker.note.textContent = 'Names come from the bank-link provider; selecting a bank does not link the account.';
          } catch (error) {
            setBankPickerOptions(picker, [], 'Search unavailable');
            picker.note.textContent = error.message;
          }
        }, 300);
      });

      picker.country.addEventListener('change', () => {
        picker.search.value = '';
        setBankPickerOptions(picker, [], 'Search for a bank');
      });
      picker.method.addEventListener('change', () => {
        picker.panel.hidden = picker.method.value !== 'ach';
      });
    });
  }

  function renderYieldDashboard(dashboard) {
    const metrics = dashboard.yieldTransparency;
    const money = amount => Number(amount || 0).toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    });
    const observed = metrics.observedSplit;
    const sourceStatus = {
      reporting: 'Yield records observed in the last 24 hours.',
      'awaiting-yield-events': 'DeFi provider connected; waiting for confirmed yield events.',
      'defi-source-not-configured': 'DeFi provider is not configured; no DeFi yield is being reported as live.',
    }[metrics.status] || 'Yield source status unavailable.';

    const balances = dashboard.investmentBalances;
    document.getElementById('initial-capital-balance').textContent = money(balances.initialCapitalAvailable);
    document.getElementById('invested-principal-note').textContent =
      `Invested principal: ${money(balances.investedPrincipal)}`;
    document.getElementById('capital-returned-note').textContent = balances.capitalReturnedToCash > 0
      ? `${money(balances.capitalReturnedToCash)} principal returned at maturity.`
      : 'Principal returns here at maturity.';
    document.getElementById('investment-profit-balance').textContent = money(balances.profitAvailable);
    document.getElementById('profit-paid-note').textContent =
      `Profit paid to date: ${money(balances.profitPaidToDate)}`;
    document.getElementById('profit-pending-note').textContent =
      `Pending profit: ${money(balances.profitPending)}`;

    document.getElementById('yield-source-status').textContent = sourceStatus;
    document.getElementById('yield-defi-gross').textContent =
      `${metrics.targetSplit.defi}% / ${observed ? `${observed.defi}%` : 'no data'}`;
    document.getElementById('yield-defi-net').textContent =
      `Gross ${money(metrics.sources.defi.gross)} · net ${money(metrics.sources.defi.net)}`;
    document.getElementById('yield-arbitrage-gross').textContent =
      `${metrics.targetSplit.arbitrage}% / ${observed ? `${observed.arbitrage}%` : 'no data'}`;
    document.getElementById('yield-arbitrage-net').textContent =
      `Gross ${money(metrics.sources.arbitrage.gross)} · net ${money(metrics.sources.arbitrage.net)}`;
    const proofSummary = source => source.lastProofRef
      ? `${source.eventCount} records · ${new Date(source.lastEventAt).toLocaleString()} · ${source.lastProofRef}`
      : 'No source record in last 24h.';
    document.getElementById('yield-defi-proof').textContent = proofSummary(metrics.sources.defi);
    document.getElementById('yield-arbitrage-proof').textContent = proofSummary(metrics.sources.arbitrage);
    document.getElementById('yield-reserve-balance').textContent = money(metrics.reserveBuffer.balance);
    document.getElementById('yield-tier-rate').textContent = dashboard.assignedTierRate
      ? `${dashboard.assignedTierRate}% monthly`
      : 'No active tier';

    const investmentTerm = dashboard.investmentProfile?.investmentTerm || dashboard.user.investmentTerm || 'lifetime';
    document.getElementById('yield-investment-term').textContent = investmentTerm === 'lifetime'
      ? 'Lifetime'
      : `${investmentTerm} ${investmentTerm === '1' ? 'year' : 'years'}`;
    const maturityAt = dashboard.investmentProfile?.maturityAt;
    document.getElementById('yield-maturity-date').textContent = maturityAt
      ? `Matures ${new Date(maturityAt).toLocaleDateString()}`
      : investmentTerm === 'lifetime' ? 'No fixed maturity' : 'Term begins with first investment';

    const nextPayout = dashboard.upcomingPayout;
    document.getElementById('yield-next-payout').textContent = nextPayout
      ? `${money(nextPayout.amount)} · ${new Date(nextPayout.dueAt).toLocaleDateString()} · ${nextPayout.status}`
      : 'No payout scheduled';
  }

  async function loadPortfolio() {
    const [{ user }, portfolio] = await Promise.all([
      apiGet('/auth/me', token),
      apiGet('/portfolio', token),
    ]);
    apiGet('/v1/user/dashboard', token)
      .then(renderYieldDashboard)
      .catch(error => console.warn('Yield transparency could not be loaded.', error));
    const tieredHolding = portfolio.holdings.filter(h => h.strategy === 'tiered').at(-1);
    if (tieredHolding) {
      document.getElementById('invest-frequency').value = tieredHolding.payout_frequency;
    }
    document.getElementById('dash-name').textContent = user.name;
    document.getElementById('dash-total').textContent =
      `$${portfolio.total_balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('invest-available-note').textContent =
      `Available initial capital: $${portfolio.available_initial_capital.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const list = document.getElementById('dash-holdings');
    list.innerHTML = '';
    portfolio.holdings.forEach(h => {
      const row = document.createElement('div');
      row.className = 'way-card reveal in';
      const payoutInterval = {
        'bi-weekly': 'bi-weekly',
        monthly: 'monthly',
        quarterly: 'quarterly',
        'bi-annually': 'bi-annually',
        annually: 'annually',
      }[h.payout_frequency] || h.payout_frequency;
      row.innerHTML = `
        <h3>${h.label}</h3>
        <p>Balance: $${h.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        ${h.strategy === 'tiered' && h.balance > 0 ? `<button class="btn btn-outline liquidity-btn" type="button" data-strategy="${h.strategy}">Request liquidity</button><p class="liquidity-note">Rate: ${h.target_yield_pct}% monthly. Payouts: ${payoutInterval}.</p>` : h.matured ? '<p class="liquidity-note">Term complete; principal returned to initial capital.</p>' : h.strategy === 'tiered' ? '<p class="liquidity-note">No principal invested.</p>' : h.archived ? '<p class="liquidity-note">Existing balance retained; new investing is closed.</p>' : ''}`;
      list.appendChild(row);
    });
    list.querySelectorAll('.liquidity-btn').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await apiPost('/portfolio/liquidity', { strategy: button.dataset.strategy }, token);
          showFundingStatus('invest-status', result.message, true);
        } catch (err) {
          showFundingStatus('invest-status', err.message, false);
          button.disabled = false;
        }
      });
    });
  }

  async function loadTransactions() {
    const tbody = document.getElementById('dash-transactions');
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--steel); font-size:13px;">Loading recent transactions…</td></tr>';
    try {
      const { transactions } = await apiGet('/payments', token);
      tbody.innerHTML = transactions.length
        ? transactions.map(t => `
          <tr>
            <td style="text-transform:capitalize;">${t.type}</td>
            <td style="text-transform:uppercase;">${t.method}</td>
            <td>$${t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="text-transform:capitalize;">${t.status}</td>
            <td>${new Date(t.created_at).toLocaleString()}</td>
          </tr>
          `).join('')
        : '<tr><td colspan="5" style="color:var(--steel); font-size:13px;">No transactions yet.</td></tr>';
    } catch (error) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.style.cssText = 'color:var(--steel); font-size:13px;';
      cell.textContent = error.name === 'TimeoutError'
        ? 'Transaction history timed out. Reload the dashboard to retry.'
        : `Transaction history unavailable: ${error.message}`;
      row.appendChild(cell);
      tbody.replaceChildren(row);
      throw error;
    }
  }

  async function loadFundingLimits() {
    const data = await apiGet('/payments/methods');
    setupBankDirectory(data.bank_directory);
    const min = (data.min_amount_cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
    const depositMax = (data.max_deposit_amount_cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
    const withdrawMax = (data.max_amount_cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
    const methodNote = (method) => {
      const state = data.methods[method];
      if (state === 'live') return '';
      if (state === 'unavailable') return ' — provider configured, transfers unavailable';
      return ' — sandbox mode, no real money moves yet';
    };
    document.getElementById('deposit-limits-note').textContent =
      `${min}–${depositMax} per deposit${methodNote('ach')}.`;
    document.getElementById('withdraw-limits-note').textContent =
      `${min}–${withdrawMax} per withdrawal${methodNote('ach')}.`;

    const depositCryptoAddress = document.getElementById('deposit-usdt-address');
    const depositCryptoCopyButton = document.getElementById('copy-usdt-address');
    const depositCryptoNote = document.getElementById('deposit-usdt-note');
    const usdtAddress = data.crypto_wallets.USDT_TRC20;
    if (depositCryptoAddress) depositCryptoAddress.textContent = usdtAddress || 'Unavailable';
    if (depositCryptoCopyButton) depositCryptoCopyButton.disabled = !usdtAddress;
    if (depositCryptoNote && !usdtAddress) {
      depositCryptoNote.textContent = 'USDT deposits are unavailable until a TRC20 receiving wallet is configured.';
    }
    syncCryptoDepositPanel();
    const copyWalletButton = depositCryptoCopyButton;
    if (copyWalletButton && depositCryptoAddress) {
      copyWalletButton.addEventListener('click', async () => {
        const address = depositCryptoAddress.textContent;
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(address);
        } else {
          const textArea = document.createElement('textarea');
          textArea.value = address;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          textArea.remove();
        }
        copyWalletButton.textContent = 'Copied';
        setTimeout(() => { copyWalletButton.textContent = 'Copy'; }, 1400);
      });
    }
  }

  function showFundingStatus(elId, message, ok) {
    const el = document.getElementById(elId);
    el.textContent = message;
    el.className = `funding-status ${ok ? 'ok' : 'err'}`;
    el.style.display = 'block';
  }

  (async () => {
    if (!token) { window.location.href = 'login.html'; return; }
    try {
      await apiGet('/auth/me', token);
    } catch (err) {
      if (err.status === 401) {
        clearSession();
        window.location.href = 'login.html';
        return;
      }
      console.error('Unable to validate the account session.', err);
    }

    try {
      await Promise.all([loadPortfolio(), loadTransactions(), loadFundingLimits()]);
    } catch (err) {
      console.error('Some dashboard data could not be loaded.', err);
    }
  })();

  if (document.getElementById('yield-transparency')) {
    const refreshTimer = window.setInterval(() => {
      if (document.hidden) return;
      apiGet('/v1/user/dashboard', token)
        .then(renderYieldDashboard)
        .catch(error => console.warn('Yield transparency refresh failed.', error));
    }, 30000);
    window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer), { once: true });
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      clearSession();
      window.location.href = 'index.html';
    });
  }

  const depositForm = document.getElementById('deposit-form');
  if (depositForm) {
    depositForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = document.getElementById('deposit-amount').value;
      const method = document.getElementById('deposit-method').value;
      const bankInstitutionId = document.getElementById('deposit-bank-results').value;
      const btn = depositForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const result = await apiPost('/payments/deposit', { amount: Number(amount), method, bankInstitutionId }, token);
        showFundingStatus('deposit-status', `Deposit ${result.status} (${result.provider} sandbox).`, true);
        depositForm.reset();
        const refreshResults = await Promise.allSettled([loadPortfolio(), loadTransactions()]);
        if (refreshResults.some(refresh => refresh.status === 'rejected')) {
          showFundingStatus('deposit-status', `Deposit ${result.status} (${result.provider} sandbox). Balance refresh failed; reload the dashboard to verify it.`, false);
        }
      } catch (err) {
        showFundingStatus('deposit-status', err.message, false);
      } finally {
        btn.disabled = false;
      }
    });
  }

  const withdrawForm = document.getElementById('withdraw-form');
  if (withdrawForm) {
    withdrawForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = document.getElementById('withdraw-amount').value;
      const method = document.getElementById('withdraw-method').value;
      const bankInstitutionId = document.getElementById('withdraw-bank-results').value;
      const walletAddress = document.getElementById('withdraw-usdt-address').value.trim();
      const btn = withdrawForm.querySelector('button');
      btn.disabled = true;
      try {
        const result = await apiPost('/payments/withdraw', { amount: Number(amount), method, bankInstitutionId, walletAddress }, token);
        showFundingStatus('withdraw-status', `Withdrawal ${result.status} (${result.provider} sandbox).`, true);
        withdrawForm.reset();
        await Promise.all([loadPortfolio(), loadTransactions()]);
      } catch (err) {
        showFundingStatus('withdraw-status', err.message, false);
      } finally {
        btn.disabled = false;
      }
    });
  }

  const investForm = document.getElementById('invest-form');
  if (investForm) {
    const amountInput = document.getElementById('invest-amount');
    const intervalInput = document.getElementById('invest-frequency');
    const rateOutput = document.getElementById('invest-rate');
    const estimateOutput = document.getElementById('invest-estimate');
    const estimateLabel = document.getElementById('invest-estimate-label');
    let quoteRequestId = 0;
    let estimateTimer;
    const updateInvestmentEstimate = async () => {
      const requestId = ++quoteRequestId;
      const principal = Number(amountInput.value);
      const interval = intervalInput.value;
      const intervalLabel = {
        'bi-weekly': 'Bi-weekly',
        monthly: 'Monthly',
        quarterly: 'Quarterly',
        'bi-annually': 'Bi-annually',
        annually: 'Annually',
      }[interval];

      if (principal < 1000) {
        rateOutput.textContent = '—';
        estimateOutput.textContent = '—';
        estimateLabel.textContent = 'Minimum investment is $1,000.';
        return;
      }

      rateOutput.textContent = '…';
      estimateOutput.textContent = '…';
      try {
        const quote = await apiPost('/v1/investments/calculate', {
          principal,
          withdrawalInterval: interval,
        }, token);
        if (requestId !== quoteRequestId) return;
        rateOutput.textContent = `${quote.appliedMonthlyRate}%`;
        estimateOutput.textContent = quote.payoutAmount.toLocaleString(undefined, {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
        });
        estimateLabel.textContent = `${intervalLabel} estimate; returns are not guaranteed.`;
      } catch (error) {
        if (requestId !== quoteRequestId) return;
        rateOutput.textContent = '—';
        estimateOutput.textContent = '—';
        estimateLabel.textContent = 'Estimate temporarily unavailable.';
      }
    };
    const scheduleEstimateUpdate = () => {
      clearTimeout(estimateTimer);
      estimateTimer = setTimeout(updateInvestmentEstimate, 200);
    };
    amountInput.addEventListener('input', scheduleEstimateUpdate);
    intervalInput.addEventListener('change', scheduleEstimateUpdate);
    updateInvestmentEstimate();

    investForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = document.getElementById('invest-amount').value;
      const withdrawal_interval = intervalInput.value;
      const btn = investForm.querySelector('button');
      btn.disabled = true;
      try {
        const result = await apiPost('/portfolio/invest', {
          amount: Number(amount), strategy: 'tiered', withdrawal_interval,
        }, token);
        showFundingStatus(
          'invest-status',
          `${result.message} ${result.appliedMonthlyRate}% monthly; estimated ${withdrawal_interval} payout: $${result.payoutAmount.toFixed(2)}.`,
          true
        );
        investForm.reset();
        await Promise.all([loadPortfolio(), loadTransactions()]);
        scheduleEstimateUpdate();
      } catch (err) {
        showFundingStatus('invest-status', err.message, false);
      } finally {
        btn.disabled = false;
      }
    });
  }
}

// ============ Referrals + logged-in navigation ============
(() => {
  const token = activeToken;
  const navActions = document.querySelectorAll('.nav-actions');
  const referralTriggers = document.querySelectorAll('.utility-links a');

  function showReferralModal() {
    if (!token) return;
    let modal = document.getElementById('referral-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'referral-modal';
      modal.className = 'referral-modal';
      modal.innerHTML = `
        <div class="referral-dialog" role="dialog" aria-modal="true" aria-labelledby="referral-title">
          <button class="referral-close" type="button" aria-label="Close referral window">×</button>
          <span class="tag-label">Invite your circle</span>
          <h2 id="referral-title">Share Blue Pips, earn commission.</h2>
          <p class="referral-copy">Your friend gets started through your link. You earn a $300 cash bonus when they make their first investment.</p>
          <label class="referral-label" for="referral-link">Your referral link</label>
          <div class="referral-copy-row"><input id="referral-link" readonly><button class="btn btn-outline referral-copy-btn" type="button">Copy link</button></div>
          <label class="referral-label" for="referral-code">Referral code</label>
          <div class="referral-copy-row"><input id="referral-code" readonly><button class="btn btn-outline referral-copy-btn" type="button">Copy code</button></div>
          <div class="referral-summary"><span>Total earned</span><strong id="referral-total">$0.00</strong></div>
          <div id="referral-status" class="referral-status"></div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('.referral-close')) modal.classList.remove('open');
        const button = event.target.closest('.referral-copy-btn');
        if (button) {
          const input = button.previousElementSibling;
          input.select();
          navigator.clipboard?.writeText(input.value);
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = input.id === 'referral-link' ? 'Copy link' : 'Copy code'; }, 1400);
        }
      });
    }

    modal.classList.add('open');
    const status = modal.querySelector('#referral-status');
    status.textContent = 'Loading your referral details…';
    apiGet('/portfolio/referrals', token).then(data => {
      modal.querySelector('#referral-link').value = data.link;
      modal.querySelector('#referral-code').value = data.code;
      modal.querySelector('#referral-total').textContent = `$${data.total_commission.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      status.textContent = `${data.referrals.length} referral${data.referrals.length === 1 ? '' : 's'} tracked.`;
    }).catch(error => { status.textContent = error.message; });
  }

  navActions.forEach(actions => {
    const login = actions.querySelector('a.login');
    if (token && login && login.id !== 'logout-btn') {
      login.textContent = 'Dashboard';
      login.href = 'dashboard.html';
    }
    if (token) {
      actions.querySelectorAll('a.btn').forEach(link => link.remove());
      if (!actions.querySelector('.referral-trigger')) {
        const referral = document.createElement('a');
        referral.className = 'referral-trigger nav-referral';
        referral.href = '#referrals';
        referral.textContent = 'Refer a friend';
        actions.prepend(referral);
      }
    }
  });

  referralTriggers.forEach(link => {
    if (link.textContent.trim().toLowerCase() !== 'refer a friend') return;
    link.classList.add('referral-trigger');
    link.addEventListener('click', event => {
      if (!token) return;
      event.preventDefault();
      showReferralModal();
    });
  });
  document.querySelectorAll('.nav-referral').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    showReferralModal();
  }));
})();

// Persistent customer support access without obscuring page content.
(() => {
  const support = document.createElement('div');
  support.className = 'support-float';
  support.innerHTML = `
    <button class="support-float-toggle" type="button" aria-label="Open customer support" aria-expanded="false" aria-controls="support-float-menu">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-1a8 8 0 0 1 16 0v1h1v4a3 3 0 0 1-3 3h-2v-2h2a1 1 0 0 0 1-1v-2h-1v1h-2v-4h2v-1a6 6 0 0 0-12 0v1h2v4H6v-1H5v2a1 1 0 0 0 1 1h2v2H6a3 3 0 0 1-3-3v-4h1Zm7 8h2v2h-2v-2Z"/></svg>
    </button>
    <div class="support-float-menu" id="support-float-menu" hidden>
      <a href="https://wa.me/message/TZ4ETYOCCZBDF1" target="_blank" rel="noopener" aria-label="WhatsApp support" title="WhatsApp support">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5A11.8 11.8 0 0 0 12.1 0C5.6 0 .3 5.3.3 11.8c0 2.1.6 4.1 1.6 5.8L.2 23.8l6.3-1.6a11.8 11.8 0 0 0 5.6 1.4h.1c6.5 0 11.8-5.3 11.8-11.8 0-3.1-1.2-6.1-3.5-8.3Z"/></svg>
      </a>
      <a href="https://t.me/bluepipsinvest" target="_blank" rel="noopener" aria-label="Telegram support" title="Telegram support">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.5 2.1 20 21.5c-.3 1.4-1 1.7-2.1 1.1l-5.8-4.3-2.8 2.7c-.3.3-.5.5-1 .5l.4-5.9L19.5 5c.5-.4-.1-.7-.7-.3L5.6 13.1 0 11.3c-1.2-.4-1.2-1.2.3-1.8L22 1c1-.4 1.9.2 1.5 1.1Z"/></svg>
      </a>
    </div>`;
  document.body.appendChild(support);
  const toggle = support.querySelector('.support-float-toggle');
  const menu = support.querySelector('.support-float-menu');
  const openMenu = () => {
    menu.removeAttribute('hidden');
    support.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  };
  const closeMenu = () => {
    menu.setAttribute('hidden', '');
    support.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  support.addEventListener('mouseenter', openMenu);
  support.addEventListener('mouseleave', closeMenu);
  support.addEventListener('focusin', openMenu);
  support.addEventListener('focusout', event => {
    if (!support.contains(event.relatedTarget)) closeMenu();
  });
  toggle.addEventListener('click', () => {
    if (menu.hasAttribute('hidden')) openMenu();
    else closeMenu();
  });
})();

// ============ Contact form (contact.html) — placeholder, not wired to a backend yet ============
const contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = contactForm.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.textContent = 'Message received (demo only) ✓';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
  });
}

// ============ Cookie / privacy notice ============
(() => {
  const DISMISS_KEY = 'bp_cookie_ack';
  if (localStorage.getItem(DISMISS_KEY)) return;

  const banner = document.createElement('div');
  banner.className = 'cookie-banner';
  banner.innerHTML = `
    <p>This site logs anonymous page views to help us understand traffic — no raw IP addresses are stored. See our <a href="privacy.html">privacy policy</a> for details.</p>
    <button class="btn btn-gold" id="cookie-ack-btn">Got it</button>
  `;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('visible'));

  document.getElementById('cookie-ack-btn').addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    banner.classList.remove('visible');
    setTimeout(() => banner.remove(), 400);
  });
})();
