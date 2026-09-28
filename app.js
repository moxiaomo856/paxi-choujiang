/* =====================================================================
 * app.js —— 抽奖前端 UI 逻辑（4 tab：奖池 / 创建 / 我的 / 管理）
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;
  const S = window.CJSession;
  const L = window.CJLottery;
  // i18n.js 万一没加载（网络/缓存问题），退化成"原文直出"，绝不能因此让整个应用起不来
  const T = (window.CJ_I18N && window.CJ_I18N.t) || ((k) => k);
  const LANG = () => (window.CJ_I18N && window.CJ_I18N.getLang()) || 'zh';

  const $ = (id) => document.getElementById(id);
  const log = (msg) => {
    const el = $('log');
    el.textContent = `[${new Date().toLocaleTimeString(LANG() === 'zh' ? 'zh-CN' : 'en-US')}] ${msg}\n` + el.textContent;
  };
  const UNCLAIMED_MAX = 30;   // 已开奖池的"未领奖"查询上限（轮询性能）

  /** 并发受限的 map：LCD 查询并发太高会被限流，8 路并发是稳妥值。
   *  串行 await 循环查 200 个池要几十秒，并行化后首屏扫描能快一个数量级。 */
  async function mapLimit(items, limit, fn) {
    const arr = Array.isArray(items) ? items : [];
    let i = 0;
    const n = Math.max(1, Math.min(limit, arr.length));
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (i < arr.length) {
          const idx = i++;
          await fn(arr[idx], idx);
        }
      })());
    }
    await Promise.all(workers);
  }

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Banner ----------
  const _bannerKind = { _k: 'info' };
  const banner = (msg, kind) => {
    const el = $('banner');
    // 清掉上一次挂的 onclick / cursor（深链分支会把 banner 变成可点跳 paxi://，
    // 不清的话之后任何错误提示点一下都会误跳）
    el.onclick = null;
    el.style.cursor = '';
    if (!msg) {
      if (_bannerKind._k !== 'info') return;   // 只清 info，错误提示不被轮询冲掉
      el.hidden = true;
      return;
    }
    _bannerKind._k = kind || 'info';
    el.hidden = false;
    el.className = 'banner ' + _bannerKind._k;
    el.textContent = msg;
  };

  /**
   * 把合约 / 链上返回的英文错误，映射成用户能看懂的中英文提示。
   * 合约错误被 cosmwasm 包成 "failed to execute message; message index: 0: <详情>: execute wasm contract failed"，
   * 所以用子串 / 关键字匹配，而不是靠精确的错误类名。找不到对应项就返回 null（沿用原文）。
   */
  function mapContractError(msg) {
    // 顺序敏感：靠前的优先匹配。每个子串都来自 error.rs 的 #[error(...)] 实际输出。
    const rules = [
      [/(already joined)/i,                     'err.alreadyJoined'],
      [/(not open for joining)/i,                'err.lotteryNotOpen'],
      [/(creator cannot join)/i,                 'err.creatorCannotJoin'],
      [/(not a participant)/i,                   'err.notParticipant'],
      [/(already expired|expired at)/i,          'err.lotteryExpired'],
      [/(has not expired yet)/i,                 'err.notExpired'],
      [/(already refunded)/i,                    'err.alreadyRefunded'],
      [/(already has refunds)/i,                 'err.refundStarted'],
      [/(already claimed)/i,                     'err.alreadyClaimed'],
      [/(nothing to claim)/i,                    'err.nothingToClaim'],
      [/(already drawn)/i,                       'err.alreadyDrawn'],
      [/(not full yet)/i,                        'err.lotteryNotFull'],
      [/(not enough participants)/i,             'err.notEnoughParticipants'],
      [/(is not a winner)/i,                     'err.notWinner'],
      [/(committed a secret but never revealed)/i, 'err.commitNotRevealed'],
      [/(no committed secret)/i,                 'err.templateCommit'],
      [/(insufficient balance|insufficient funds)/i, 'err.insufficientBalance'],
      [/(too many active sessions)/i,            'err.sessionLimit'],
      [/(session not found|invalid signature|nonce mismatch)/i, 'err.sessionError'],
      [/(out of gas|gas insufficient|insufficient fee)/i, 'err.gasError'],
      [/(contract is paused)/i,                  'err.paused'],
      [/(unauthorized)/i,                        'err.unauthorized'],
      [/(must be greater than zero)/i,            'err.zeroAmount'],
      [/(multisig required)/i,                   'err.multisig'],
    ];
    for (const [re, key] of rules) {
      if (re.test(msg)) return T(key);
    }
    return null;
  }

  function fail(e, prefix) {
    const msg = (e && e.message) ? e.message : String(e);
    const friendly = mapContractError(msg);
    if (e && e.needSession) {
      const b = $('btnSession');
      b.hidden = false;
      b.classList.add('primary');
      b.classList.remove('ghost');
      b.textContent = T('wallet.openSession');
      refreshSessionCard();
    }
    // 日志记原文（方便排查），横幅显示友好提示（找不到则回退原文）
    log((prefix ? prefix + '：' : '') + msg);
    banner(friendly || msg, 'err');
  }

  // ---------- 手机端防双击 ----------
  // 触屏连点会发出两笔交易（双倍扣费）。全局锁：有交易在途时拦截新操作。
  let txBusy = false;

  /** 等交易库就位（cosmjs 2.6MB 是后台异步加载的） */
  function waitCosmjs(ms = 20000) {
    return new Promise((resolve) => {
      if (typeof PaxiCosmJS !== 'undefined') return resolve(true);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (typeof PaxiCosmJS !== 'undefined') { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
      }, 200);
    });
  }

  async function guardBusy(btn, fn) {
    if (txBusy) {
      banner(T('common.busy'), 'warn');
      return;
    }
    if (typeof PaxiCosmJS === 'undefined') {
      banner(T('common.libLoading'), 'info');
      const ok = await waitCosmjs();
      if (!ok) {
        banner(T('common.libFail'), 'err');
        return;
      }
      banner('');
    }
    txBusy = true;
    // 存 innerHTML：领奖按钮是图标+文字，只还原 textContent 会丢掉图标
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = T('common.processing'); }
    try {
      await fn();
    } finally {
      txBusy = false;
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    }
  }

  // ---------- 复制 ----------
  async function copyText(text, label) {
    const s = String(text == null ? '' : text);
    if (!s) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(s);
      } else {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      log(T('common.copyOk', { label: label ? ' ' + label : '' }));
      banner(T('common.copyOk', { label: label ? ' ' + label : '' }), 'info');
    } catch (e) {
      banner(T('common.copyFail'), 'warn');
    }
  }
  function copyable(text, label, display) {
    const t = String(text == null ? '' : text);
    const d = display == null ? t : String(display);
    return `<span class="copyable" data-copy="${escapeHtml(t)}" data-copy-label="${escapeHtml(label || '')}">${escapeHtml(d)}</span>`;
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-copy]');
    if (!el) return;
    e.preventDefault();
    copyText(el.dataset.copy, el.dataset.copyLabel || '');
  });

  // ---------- 全局状态 ----------
  let tkccInfo = { token: '', decimals: C.tkccDecimals, configured: false };
  let isAdmin = false;
  let adminFromChain = false;
  let chainAdmins = [];
  let chainThreshold = 0;
  let currentTab = 'pools';
  let allPools = [];
  let selectedTier = Number(C.defaultTier || 0);
  let refreshing = false;
  let sharedPoolId = null;      // 从分享链接解析出的目标奖池
  let poolsLoaded = false;      // 首次加载用骨架屏
  // 内部余额（raw，字符串），用于"余额不足"预检
  let balPaxiRaw = '0';
  let balTkccRaw = '0';
  let myJoinedIds = new Set();      // 我参与过的池 id（列表打"已参与"标）
  let pendingClaims = [];           // 待领奖（奖池页顶部展示）
  // 奖池视图缓存（id → view）：奖池页与我的页都会写入，
  // 按钮操作从这里取，避免在我的页点到奖池页列表里没有的池（如已退款池）
  let poolCache = new Map();
  // 终态数据缓存（性能关键）：
  //   - participantsCache：池子一旦"冻结"（满员/已开奖/已退款/已取消/已截止），
  //     参与者名单**永远不再变化** → 查一次永久缓存；
  //   - unclaimedCache：drawn 池的未领名单只在有人领奖时变化 → 缓存，
  //     领奖成功时按 id 失效（onAction claim 分支）。
  // 没有这两个缓存，"我的"页每 10 秒轮询会串行打 2×N 个 LCD 查询，池子一多必卡。
  const participantsCache = new Map();  // id → bool（仅冻结池）
  const unclaimedCache = new Map();     // id → pending 数组（仅 drawn 池）

  // =====================================================================
  // Tab 切换
  // =====================================================================
  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('.page').forEach((el) => {
      el.hidden = el.id !== 'page-' + name;
    });
    document.querySelectorAll('.tabbar .tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (name === 'me')    refreshMyPage().catch(() => {});
    if (name === 'admin') refreshAdminPage().catch(() => {});
    if (name === 'pools') refreshPools().catch(() => {});
    if (name === 'create') updateCostBox();
  }
  document.querySelectorAll('.tabbar .tab').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  // =====================================================================
  // 无感引导卡片
  // =====================================================================
  function refreshSessionCard() {
    const card = $('sessionCard');
    if (!card) return;
    if (!K.wallet.address) {
      card.hidden = false;
      $('sessionCardTitle').textContent = T('sessCard.titleConnect');
      $('sessionCardDesc').textContent  = T('sessCard.descConnect');
      $('btnSessionCard').textContent   = T('sessCard.btnConnect');
      $('btnSessionCard').onclick       = () => guardBusy($('btnSessionCard'), () => onConnect());
      return;
    }
    if (S.state.enabled) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('sessionCardTitle').textContent = T('sessCard.titleEnable');
    $('sessionCardDesc').textContent  = T('sessCard.descEnable');
    $('btnSessionCard').textContent   = T('sessCard.btnEnable');
    $('btnSessionCard').onclick       = () => guardBusy($('btnSessionCard'), () => onSession());
  }

  // =====================================================================
  // 钱包 / 会话
  // =====================================================================
  async function onConnect() {
    const addr = await K.connect();
    $('addr').innerHTML = copyable(addr, '地址', addr.slice(0, 10) + '…' + addr.slice(-6));
    $('btnSession').hidden = false;
    // 清掉连接前遗留的错误横幅（注入完成前点过连接会留下误导性报错）
    _bannerKind._k = 'info';
    banner('');

    if (!(window.CJHash && (await window.CJHash.ready()))) {
      banner(T('msg.cryptoLibFail'), 'warn');
    }
    if (S.restore()) {
      await S.syncNonce();
      if (S.state.enabled) {
        $('sessTag').hidden = false;
        $('btnSession').textContent = T('wallet.closeSession');
      } else {
        $('sessTag').hidden = true;
        $('btnSession').textContent = T('wallet.openSession');
        log(T('msg.sessionExpired'));
      }
    }
    await detectAdmin();
    refreshSessionCard();
    await refreshTkcc(true).catch(() => {});
    await refreshBalance().catch(() => {});
    await refreshPools().catch(() => {});
    log(T('msg.connected', { addr }));
    autoEnableTkcc().catch(() => {});
  }

  async function detectAdmin() {
    try {
      const res = await K.queryContract({ admins: {} });
      chainAdmins = res.admins || [];
      chainThreshold = res.threshold || 0;
      isAdmin = chainAdmins.includes(K.wallet.address);
      adminFromChain = true;
    } catch (e) {
      isAdmin = (C.admins || []).includes(K.wallet.address);
      adminFromChain = false;
    }
    $('tabAdmin').hidden = !isAdmin;
  }

  function renderAdmins() {
    const list = adminFromChain && chainAdmins.length ? chainAdmins : (C.admins || []);
    const sep = LANG() === 'zh' ? '、' : ', ';
    const listStr = list.length ? list.join(sep) : '—';
    $('adminsStatus').textContent = T('msg.adminsLine', {
      src: adminFromChain ? T('msg.statusOnchain') : T('msg.statusFallback'),
      t: chainThreshold || C.multisigThreshold,
      list: listStr,
    });
  }

  async function onSession() {
    if (S.state.enabled) {
      S.clear();
      $('sessTag').hidden = true;
      $('btnSession').textContent = T('wallet.openSession');
      log(T('msg.sessionClosed'));
      refreshSessionCard();
      return;
    }
    try {
      const a = await S.enable();
      $('sessTag').hidden = false;
      $('btnSession').textContent = T('wallet.closeSession');
      log(T('msg.sessionOpened', { addr: a }));
      banner(T('msg.sessionOpenedBanner', { h: C.sessionTtlHours || 24, g: (Number(C.sessionGasFund || 300000) / 1e6).toFixed(2) }), 'info');
      refreshSessionCard();
      if (currentTab === 'me') refreshSessionStatus().catch(() => {});
    } catch (e) {
      // 开无感失败（含合约 "Too many active sessions" 等业务拒绝）：
      // 之前没接 fail()，合约报错直接裸奔；现在走友好映射 + 日志留原文
      fail(e, T('err.enableSession'));
      refreshSessionCard();
    }
  }

  // =====================================================================
  // TKCC / 余额
  // =====================================================================
  async function refreshTkcc(quiet) {
    try {
      tkccInfo = await L.resolveTkcc();
      $('balTkccLabel').textContent = tkccInfo.symbol || 'TKCC';
      $('tkccStatus').textContent = tkccInfo.token
        ? T('msg.tkccStatusLine', {
            addr: tkccInfo.token,
            symbol: tkccInfo.symbol,
            d: tkccInfo.decimals,
            on: tkccInfo.configured ? T('common.yes') : T('common.no'),
          })
        : T('msg.tkccStatusEmpty');

      if (tkccInfo.burnMode) $('burnMode').value = tkccInfo.burnMode;
      if (tkccInfo.burnAddress && !$('burnAddr').value) $('burnAddr').value = tkccInfo.burnAddress;

      const btn = $('btnSetTkcc');
      btn.textContent = tkccInfo.configured ? T('admin.rewriteTkcc') : T('admin.enableTkcc');
      btn.classList.toggle('ghost', tkccInfo.configured);
      btn.classList.toggle('primary', !tkccInfo.configured);

      if (quiet) return;
      if (tkccInfo.configured) banner('');
      else if (isAdmin && tkccInfo.token) banner(T('msg.tkccNotConfiguredAdmin'), 'warn');
      else banner(T('msg.tkccNotConfigured'), 'warn');
    } catch (e) {
      if (!quiet) banner(e.message || String(e), 'err');
    }
  }

  async function refreshBalance() {
    if (!K.wallet.address) return;
    // 不解析 Balances 列表猜 native key（旧代码假设空字符串，实际可能不是），
    // 改成各查一次：PAXI 用 token=null，TKCC 用显式地址。
    try {
      const p = await L.balance(K.wallet.address, null);
      balPaxiRaw = String(p.balance || '0');
      $('balPaxi').textContent = L.fmtPaxi(balPaxiRaw);
    } catch (e) { /* 忽略 */ }
    try {
      if (tkccInfo.token) {
        const t = await L.balance(K.wallet.address, tkccInfo.token);
        balTkccRaw = String(t.balance || '0');
        $('balTkcc').textContent = L.fmtTkcc(balTkccRaw, tkccInfo.decimals);
      } else {
        balTkccRaw = '0';
        $('balTkcc').textContent = '—';
      }
    } catch (e) { /* 忽略 */ }
    try {
      const bank = await K.getBankBalances(K.wallet.address);
      const p = bank.find((b) => b.denom === C.coinMinimalDenom);
      $('bankPaxi').textContent = L.fmtPaxi(p ? p.amount : '0');
    } catch (e) { /* 忽略 */ }
    updateCostBox();
  }

  // =====================================================================
  // 奖池：刷新 + 渲染
  // =====================================================================
  function showSkeleton() {
    $('list').innerHTML = [0, 1, 2].map(() =>
      '<div class="skeleton"><i class="w40"></i><i class="w70"></i><i class="w40"></i></div>'
    ).join('');
  }

  async function refreshPools() {
    if (refreshing) return;
    refreshing = true;
    try {
      if (!poolsLoaded) showSkeleton();
      const mode = $('fStatus').value || '';
      const status = (mode === '' || mode === 'all') ? null : mode;
      const res = await L.lotteries(status, 100);
      const list = (res.lotteries || []).filter((l) => !l.is_template_pool);

      // 已开奖池要查"谁还没领"：优先用缓存（领奖成功时失效），轮询零重复查询
      for (const l of list.filter((x) => x.status === 'drawn').slice(0, UNCLAIMED_MAX)) {
        if (unclaimedCache.has(l.id)) { l._unclaimed = unclaimedCache.get(l.id); continue; }
        try {
          const un = await L.unclaimed(l.id);
          l._unclaimed = (un && un.pending) || [];
        } catch (_) { l._unclaimed = []; }
        unclaimedCache.set(l.id, l._unclaimed);
      }

      let views = list.map((l) => {
        const v = L.toView(l, tkccInfo.decimals);
        v._unclaimed = l._unclaimed;
        return v;
      });
      views.forEach((v) => poolCache.set(v.id, v));

      // 维护"我参与过"状态：只对进行中(open 且未过期)且尚未标记过的池查 participants()。
      // 目的：① "已参与"标签正确；② 参与按钮对已参与的池隐藏（避免重复点触发 AlreadyJoined）。
      // 已标记过的池跳过查询 → 轮询 / 切 tab 几乎零额外请求。
      if (K.wallet.address) {
        for (const v of views) {
          if ((v.statusView || v.status) !== 'open' || v.expired) continue;
          if (myJoinedIds.has(v.id)) continue;
          try {
            const ps = await L.participants(v.id);
            if ((ps.participants || []).includes(K.wallet.address)) myJoinedIds.add(v.id);
          } catch (_) { /* 忽略单池查询失败 */ }
        }
      }

      views = sortPools(views);

      // 默认"进行中"/"报名中"：过滤掉已退款、已开奖且奖金已领完、以及已截止只能退款的死池
      // （死池只出现在"全部"里；创建人 / 参与者也能在"我的"页看到并退款）
      if (mode !== 'all') {
        views = views.filter((v) => {
          if (v.status === 'refunded') return false;
          if ((v.statusView || v.status) === 'expired') return false;
          if (v.status === 'drawn' && Array.isArray(v._unclaimed) && v._unclaimed.length === 0) return false;
          return true;
        });
      }

      allPools = views;
      poolsLoaded = true;
      // 待领奖：中奖名单就在 Lottery 对象里（无需额外查询），
      // 再配合上面已查过的 unclaimed 即可判定"我中奖且还没领"
      pendingClaims = views.filter((v) => {
        if (v.status !== 'drawn' || !v.winners || !K.wallet.address) return false;
        const me = K.wallet.address;
        const won = (v.winners.first || []).includes(me) || (v.winners.second || []).includes(me);
        return won && (v._unclaimed || []).includes(me);
      });
      renderClaimsTop();
      renderPoolList();

      if (sharedPoolId) setTimeout(() => highlightSharedPool(sharedPoolId), 300);
    } finally {
      refreshing = false;
    }
  }

  /**
   * 排序（基于派生状态 statusView）：
   *   进行中(open) → 满员待开(full) → 已开奖(drawn) → 已截止可退款(expired) → 已退款/取消；
   * 同状态内「快满员的靠前」（进度高的更容易成局），进度相同则快截止的靠前。
   * 用派生状态让"时间到了没满员"的死池沉到最底，新池 / 进行中池自然回到顶部。
   */
  const STATUS_RANK = { open: 0, full: 1, drawn: 2, expired: 3, refunded: 4, cancelled: 4 };
  function sortPools(views) {
    return views.slice().sort((a, b) => {
      const rank = (v) => STATUS_RANK[(v.statusView || v.status) || ''] ?? 9;
      const r = rank(a) - rank(b);
      if (r) return r;
      const pa = a.maxPeople ? a.count / a.maxPeople : 0;
      const pb = b.maxPeople ? b.count / b.maxPeople : 0;
      if (pb !== pa) return pb - pa;
      return (a.expiresAt || 0) - (b.expiresAt || 0);
    });
  }

  /** 奖池页顶部的待领奖区块：有才显示，点一下即可领 */
  function renderClaimsTop() {
    const box = $('claimsTop');
    if (!box) return;
    const n = pendingClaims.length;
    box.hidden = n === 0;

    // 我的 tab 红点：切到别的 tab（创建/管理）时也看得到还有待领
    const dot = $('tabMeDot');
    if (dot) dot.hidden = n === 0;

    const cnt = $('claimsCount');
    if (cnt) {
      cnt.textContent = n > 1 ? String(n) : '';
      cnt.hidden = n <= 1;
    }

    if (n === 0) { $('claimsTopList').innerHTML = ''; return; }
    $('claimsTopList').innerHTML = pendingClaims.map(renderPoolCard).join('');
    bindCardActions($('claimsTopList'));
  }

  function renderPoolList() {
    const el = $('list');
    if (!allPools.length) {
      el.innerHTML = '<div class="empty"><span class="big">🫥</span>' + T('pools.empty') + '</div>';
      return;
    }
    el.innerHTML = allPools.map(renderPoolCard).join('');
    bindCardActions(el);
  }

  /** 剩余时间：剩余 X 小时 Y 分 / 已截止 */
  function leftText(expiresAt) {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return '<span class="left">' + T('pools.expired') + '</span>';
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    if (d > 0) return `<span class="left">${T('pools.leftDays', { d, h })}</span>`;
    if (h > 0) return `<span class="left">${T('pools.leftHours', { h, m: mm })}</span>`;
    return `<span class="left">${T('pools.leftMinutes', { m: mm })}</span>`;
  }

  function renderPoolCard(v) {
    const pct = v.maxPeople ? Math.min(100, Math.round((v.count / v.maxPeople) * 100)) : 0;
    const me = K.wallet.address;
    const isCreator = !!me && v.creator === me;
    const joined = !!me && myJoinedIds.has(v.id);
    const expired = v.expired;                       // 用统一派生状态，与排序 / 徽章一致
    const statusView = v.statusView || v.status;

    const stateCls = statusView === 'open' ? 'is-open'
      : statusView === 'full' ? 'is-full'
      : statusView === 'drawn' ? 'is-drawn'
      : statusView === 'expired' ? 'is-expired'
      : statusView === 'refunded' ? 'is-refunded' : '';

    const acts = [];
    if (v.status === 'open' && !expired) {
      // 建池者不能参与自己的池（合约已拒绝）；已参与过的人也不显示「参与」按钮
      // （避免反复点击触发 AlreadyJoined；myJoinedIds 由 refreshPools / 参与成功后维护）
      if (!isCreator && !joined) {
        acts.push(`<button class="btn sm primary" data-act="join" data-id="${v.id}">${T('pools.join')}</button>`);
      }
      acts.push(`<button class="btn sm ghost share-btn" data-act="share" data-id="${v.id}">${T('common.share')}</button>`);
    }
    if (v.status === 'full') {
      acts.push(`<button class="btn sm primary" data-act="draw" data-id="${v.id}">${T('pools.draw')}</button>`);
    }
    // 退款按钮：已截止且未开奖 / 未退款的池，只给"参与过的人 / 建池人"看
    // （合约层面非参与者点退款会被拒，这里把按钮对齐合约，消除"点了报错"的陷阱）
    if (expired && v.status !== 'drawn' && v.status !== 'refunded' && (joined || isCreator)) {
      acts.push(`<button class="btn sm ghost" data-act="refund" data-id="${v.id}">${T('pools.refund')}</button>`);
    }

    const winHtml = renderWinBanner(v, me);

    return `<div class="item ${stateCls}" data-id="${v.id}">
      <div class="item-top">
        <span class="id">${copyable(String(v.id), '抽奖 ID', '#' + v.id)}</span>
        <span class="st ${statusView}">${v.statusText}</span>
        ${isCreator ? '<span class="st mine">' + T('pools.tagMine') + '</span>' : ''}
        ${joined ? '<span class="st joined">' + T('pools.tagJoined') + '</span>' : ''}
      </div>

      <div class="meta">${T('pools.fee')} <b>${v.joinPaxi}</b> PAXI + <b>${v.joinTkcc}</b> TKCC</div>
      <div class="meta">${T('pools.pool')} <b>${v.poolPaxi}</b> PAXI / <b>${v.poolTkcc}</b> TKCC</div>

      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="meta">${T('pools.people', { c: v.count, m: v.maxPeople })} · ${leftText(v.expiresAt)}${v.randomSource ? ' · ' + escapeHtml(v.randomSource) : ''}</div>

      ${winHtml}
      ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}
    </div>`;
  }

  function renderWinBanner(v, me) {
    if (v.status !== 'drawn' || !me) return '';
    const w = v.winners;
    if (!w) return '';

    const isFirst  = (w.first  || []).includes(me);
    const isSecond = (w.second || []).includes(me);
    if (!isFirst && !isSecond) return '';

    const pending = v._unclaimed;
    const claimed = Array.isArray(pending) && !pending.includes(me);

    if (isFirst) {
      if (claimed) {
        return `<div class="win-banner first claimed">
          <span class="ico">🏆</span><span>${T('pools.winFirstDone')}</span>
        </div>`;
      }
      return `<div class="win-banner first">
        <span class="ico">🎉</span><span>${T('pools.winFirst')}</span>
      </div>
      <button class="claim-btn" data-act="claim" data-id="${v.id}">
        <span>💰</span><span>${T('pools.claimNow')}</span>
      </button>`;
    }
    if (isSecond) {
      if (claimed) {
        return `<div class="win-banner second claimed">
          <span class="ico">🥈</span><span>${T('pools.winSecondDone')}</span>
        </div>`;
      }
      return `<div class="win-banner second">
        <span class="ico">🎉</span><span>${T('pools.winSecond')}</span>
      </div>
      <button class="claim-btn second" data-act="claim" data-id="${v.id}">
        <span>💰</span><span>${T('pools.claimNow')}</span>
      </button>`;
    }
    return '';
  }

  function bindCardActions(root) {
    root.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => guardBusy(b, () => onAction(b.dataset.act, Number(b.dataset.id), b));
    });
  }

  // =====================================================================
  // 我的页
  // =====================================================================
  async function refreshMyPage() {
    if (!K.wallet.address) {
      $('myClaims').innerHTML  = '<div class="empty">' + T('me.needConnect') + '</div>';
      $('myCreated').innerHTML = '';
      $('myJoined').innerHTML  = '';
      return;
    }
    await refreshBalance();
    refreshSessionStatus().catch(() => {});

    const me = K.wallet.address;
    const res = await L.lotteries(null, 200).catch(() => ({ lotteries: [] }));
    const pools = (res.lotteries || [])
      .filter((l) => !l.is_template_pool)
      .map((l) => L.toView(l, tkccInfo.decimals));

    const created = [];
    const joined  = [];
    const claims  = [];
    myJoinedIds = new Set();

    // 8 路并发 + 终态缓存：冻结池的 participants / drawn 池的 unclaimed 只查一次，
    // 之后每 10 秒的轮询只查活跃池（open 且未过期），LCD 压力降一个数量级。
    await mapLimit(pools, 8, async (v) => {
      poolCache.set(v.id, v);
      if (v.status === 'drawn') {
        if (unclaimedCache.has(v.id)) {
          v._unclaimed = unclaimedCache.get(v.id);
        } else {
          try {
            const un = await L.unclaimed(v.id);
            v._unclaimed = (un && un.pending) || [];
          } catch (_) { v._unclaimed = []; }
          unclaimedCache.set(v.id, v._unclaimed);
        }
      }

      if (v.creator === me) { created.push(v); return; }

      let isJoined = false;
      // 冻结判定：非 open（满员/已开奖/已退款/已取消）或已截止 → 名单不再变化，可缓存
      const frozen = v.status !== 'open' || v.expired;
      if (frozen && participantsCache.has(v.id)) {
        isJoined = participantsCache.get(v.id);
      } else {
        try {
          const ps = await L.participants(v.id);
          isJoined = (ps.participants || []).includes(me);
        } catch (_) { isJoined = false; }
        if (frozen) participantsCache.set(v.id, isJoined);
      }

      if (isJoined) {
        myJoinedIds.add(v.id);
        joined.push(v);
        if (v.status === 'drawn' && v.winners) {
          const isFirst  = (v.winners.first  || []).includes(me);
          const isSecond = (v.winners.second || []).includes(me);
          if ((isFirst || isSecond) && Array.isArray(v._unclaimed) && v._unclaimed.includes(me)) {
            claims.push(v);
          }
        }
      }
    });

    $('myClaims').innerHTML  = claims.length
      ? claims.map(renderPoolCard).join('')
      : '<div class="empty"><span class="big">🎈</span>' + T('me.emptyClaims') + '</div>';

    $('myCreated').innerHTML = created.length
      ? created.map(renderPoolCard).join('')
      : '<div class="empty"><span class="big">🏗️</span>' + T('me.emptyCreated') + '</div>';

    $('myJoined').innerHTML  = joined.length
      ? joined.map(renderPoolCard).join('')
      : '<div class="empty"><span class="big">🎯</span>' + T('me.emptyJoined') + '</div>';

    bindCardActions($('myClaims'));
    bindCardActions($('myCreated'));
    bindCardActions($('myJoined'));

    // 待领奖以"我的"页结果为准（这里扫的是全部池，更全），同步给顶部区块与红点
    pendingClaims = claims;
    renderClaimsTop();
    // 奖池列表里同步"已参与"标记
    if (currentTab === 'pools') renderPoolList();
  }

  // =====================================================================
  // 我的页：无感会话状态 + gas 余额
  // =====================================================================
  async function refreshSessionStatus() {
    const el = $('sessStateText');
    const gasEl = $('sessGasText');
    const btn = $('btnSessionMe');
    if (!el) return;

    if (!K.wallet.address) {
      el.textContent = T('sessStatus.notConnected');
      el.className = 'v off';
      gasEl.textContent = T('sessStatus.connectHint');
      gasEl.className = 'hint';
      btn.textContent = T('wallet.connect');
      btn.onclick = () => guardBusy(btn, () => onConnect());
      return;
    }

    if (!S.state.enabled) {
      el.textContent = T('sessStatus.off');
      el.className = 'v off';
      gasEl.textContent = T('sessStatus.offHint');
      gasEl.className = 'hint';
      btn.textContent = T('sessCard.btnEnable');
      btn.onclick = () => guardBusy(btn, () => onSession());
      return;
    }

    el.textContent = T('sessStatus.on');
    el.className = 'v on';
    btn.textContent = T('wallet.closeSession');
    btn.onclick = () => guardBusy(btn, () => onSession());

    // gas 余额：会话账户自己付 gas，用完会静默回退弹钱包，这里提前提醒
    try {
      const raw = await K.getBankUpaxi(S.state.sessAddr);
      const paxi = L.fmtPaxi(raw);
      const times = Math.floor(Number(raw || 0) / (Number(C.defaultGas || 600000) * C.gasPrice));
      gasEl.textContent = T('sessStatus.gas', { v: paxi, n: times });
      gasEl.className = Number(raw || 0) < 100000 ? 'hint low' : 'hint';
      if (Number(raw || 0) < 100000) {
        gasEl.textContent = T('sessStatus.gasLow', { v: paxi });
      }
    } catch (_) {
      gasEl.textContent = T('sessStatus.gasMissing');
      gasEl.className = 'hint low';
    }
  }

  // =====================================================================
  // 管理页
  // =====================================================================
  async function refreshAdminPage() {
    if (!isAdmin) return;
    renderAdmins();
    await refreshContractInfo().catch(() => {});
    await refreshTkcc(true).catch(() => {});
  }

  async function refreshContractInfo() {
    try {
      const cfg = await L.contractConfig();
      const t = cfg.treasury || '';
      const match = t === C.treasury;
      $('treasuryStatus').textContent =
        T('msg.treasuryLine', { v: t || '—' })
        + (t && !match ? T('msg.treasuryMismatch', { v: C.treasury }) : '')
        + (cfg.paused ? T('msg.paused') : '');
      $('btnSetTreasury').textContent = match ? T('msg.treasurySame') : T('msg.treasuryWrite');
      $('btnSetTreasury').classList.toggle('ghost', match);
    } catch (e) {
      $('treasuryStatus').textContent = T('msg.treasuryConfigFallback', { v: C.treasury });
    }
  }

  // =====================================================================
  // 分享
  // =====================================================================
  function buildShareUrl(id) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('pool', id);
    return url.toString();
  }

  async function sharePool(v) {
    if (!v) return;
    const shareUrl = buildShareUrl(v.id);
    const title = T('share.title', { id: v.id });
    const text = T('share.body', {
      id: v.id,
      jp: v.joinPaxi, jt: v.joinTkcc,
      pp: v.poolPaxi, pt: v.poolTkcc,
    });

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: shareUrl });
        log(T('msg.shareLog', { id: v.id }));
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // 用户取消
      }
    }
    await copyText(shareUrl, T('common.share'));
  }

  function parseSharedPool() {
    try {
      const params = new URLSearchParams(window.location.search);
      const id = Number(params.get('pool') || 0);
      if (id > 0) sharedPoolId = id;
    } catch (e) {}
  }

  function highlightSharedPool(targetId) {
    const card = document.querySelector(`.item[data-id="${targetId}"]`);
    if (!card) {
      // 目标池不在当前筛选里 → 切"全部"再试一次
      if ($('fStatus').value !== 'all') {
        $('fStatus').value = 'all';
        refreshPools().then(() => {
          setTimeout(() => highlightSharedPool(targetId), 300);
        }).catch(() => {});
      }
      return;
    }

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('highlight');
    setTimeout(() => card.classList.remove('highlight'), 5000);

    if (!K.wallet.address) {
      banner(T('msg.shareBannerNoWallet', { id: targetId }), 'info');
    } else {
      banner(T('msg.shareBanner', { id: targetId }), 'info');
    }

    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('pool');
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
    sharedPoolId = null;
  }

  // =====================================================================
  // 动作
  // =====================================================================
  /** 参与前的内部余额预检：避免白扣 gas 后合约报 Insufficient */
  function checkAfford(v) {
    const needPaxi = BigInt(v.joinPaxiRaw || '0');
    const needTkcc = BigInt(v.joinTkccRaw || '0');
    const hasPaxi = BigInt(balPaxiRaw || '0');
    const hasTkcc = BigInt(balTkccRaw || '0');
    const shortPaxi = needPaxi > hasPaxi;
    const shortTkcc = needTkcc > hasTkcc;
    if (!shortPaxi && !shortTkcc) return true;
    const need = `${v.joinPaxi} PAXI + ${v.joinTkcc} TKCC`;
    const lack = `${shortPaxi ? L.fmtPaxi(needPaxi - hasPaxi) + ' PAXI ' : ''}`
      + `${shortTkcc ? L.fmtTkcc(needTkcc - hasTkcc, tkccInfo.decimals) + ' TKCC' : ''}`;
    banner(T('create.balShort', { need, lack }), 'err');
    return false;
  }

  async function onAction(act, id, btn) {
    try {
      if (act === 'join') {
        const v = poolCache.get(id) || allPools.find((x) => x.id === id);
        if (!v) return banner(T('msg.poolNotFound'), 'err');
        if (!checkAfford(v)) return;
        const res = await L.joinLottery(id, v.joinTkccRaw, v.joinPaxiRaw);
        log(T('msg.joinOk', { id }) + (res.transactionHash ? ' tx=' + res.transactionHash : ''));
        // 立即标记"我已参与"并重渲列表，让卡片即时进入"已参与"态、隐藏「参与」按钮
        // （真正的参与人数与状态由紧随其后的 refreshPools 用链上数据刷新）
        myJoinedIds.add(id);
        if (currentTab === 'pools') renderPoolList();
        await S.syncNonce().catch(() => {});
        banner(T('msg.joinOkBanner'), 'info');
      } else if (act === 'draw') {
        await L.drawLottery(id);
        log(T('msg.drawOk', { id }));
        banner(T('msg.drawOkBanner'), 'info');
      } else if (act === 'claim') {
        if (btn) { btn.disabled = true; btn.innerHTML = `<span>⏳</span><span>${T('pools.claiming')}</span>`; }
        try {
          await L.claim(id);
          unclaimedCache.delete(id);   // 领奖成功：该池未领名单已变化，失效缓存让下次刷新取新值
          log(T('msg.claimOk', { id }));
          banner(T('msg.claimOkBanner'), 'info');
        } finally {
          if (btn) btn.disabled = false;
        }
      } else if (act === 'refund') {
        await L.refund(id);
        log(T('msg.refundLog', { id }));
        banner(T('msg.refundOk'), 'info');
      } else if (act === 'share') {
        const v = poolCache.get(id) || allPools.find((x) => x.id === id);
        await sharePool(v);
        return;   // 分享不刷新列表
      }

      if (currentTab === 'pools') await refreshPools().catch(() => {});
      if (currentTab === 'me')    await refreshMyPage().catch(() => {});
      if (currentTab === 'admin') await refreshAdminPage().catch(() => {});
      await refreshBalance().catch(() => {});
    } catch (e) {
      fail(e, T('err.action'));
    }
  }

  // =====================================================================
  // 创建
  // =====================================================================
  function renderTierList() {
    const el = $('tierList');
    el.innerHTML = C.tiers.map((t) => `
      <div class="tier-card ${t.id === selectedTier ? 'selected' : ''}" data-tier="${t.id}">
        <h3>${t.label}<span class="badge">${T('create.peopleFull', { n: t.people })}</span></h3>
        <div class="meta">${T('create.perJoin')}<b>${t.joinPaxi}</b> PAXI + <b>${L.fmtWan(t.joinTkcc)}</b> TKCC</div>
        <div class="meta">${T('create.fee')}<b>${t.createPaxi}</b> PAXI + <b>${L.fmtWan(t.createTkcc)}</b> TKCC${T('create.feeNote')}</div>
      </div>
    `).join('');
    el.querySelectorAll('.tier-card').forEach((card) => {
      card.onclick = () => {
        selectedTier = Number(card.dataset.tier);
        renderTierList();
        updateCostBox();
      };
    });
  }

  /** 创建页费用 + 余额校验 */
  function updateCostBox() {
    const t = C.tiers.find((x) => x.id === Number(selectedTier)) || C.tiers[0];
    const needPaxi = BigInt(L.paxiToRaw(t.createPaxi));
    const needTkcc = BigInt(L.tkccToRaw(t.createTkcc, tkccInfo.decimals));
    const hasPaxi = BigInt(balPaxiRaw || '0');
    const hasTkcc = BigInt(balTkccRaw || '0');
    const ok = hasPaxi >= needPaxi && hasTkcc >= needTkcc;

    $('costCreate').textContent = `${t.createPaxi} PAXI + ${L.fmtWan(t.createTkcc)} TKCC`;
    const balEl = $('costBal');
    balEl.textContent = `${L.fmtPaxi(balPaxiRaw)} PAXI / ${L.fmtTkcc(balTkccRaw, tkccInfo.decimals)} TKCC`;
    balEl.className = ok ? '' : 'short';

    const btn = $('btnCreate');
    btn.disabled = !ok;
    btn.textContent = ok
      ? T('create.btn')
      : T('create.btnShort');
  }

  async function onCreate() {
    try {
      const res = await L.createLottery({ tier: selectedTier });
      log(T('msg.createOk') + (res.transactionHash ? ' tx=' + res.transactionHash : ''));
      banner(T('msg.createOkBanner'), 'info');
      await S.syncNonce().catch(() => {});
      switchTab('me');
    } catch (e) {
      fail(e, T('err.create'));
    }
  }

  // =====================================================================
  // 充值 / 提现
  // =====================================================================
  async function onDeposit() {
    const amount = $('depAmount').value;
    const token = $('depToken').value;
    if (!amount || Number(amount) <= 0) return banner(T('msg.inputAmount'), 'warn');
    try {
      if (token === 'paxi') await L.depositPaxi(amount);
      else await L.depositTkcc(amount);
      log(T('msg.depositOk', { a: amount, t: token.toUpperCase() }));
      await refreshBalance();
      banner(T('msg.depositOkBanner'), 'info');
    } catch (e) { fail(e, T('err.deposit')); }
  }

  async function onWithdraw() {
    const amount = $('depAmount').value;
    const token = $('depToken').value;
    if (!amount || Number(amount) <= 0) return banner(T('msg.inputAmount'), 'warn');
    try {
      const raw = token === 'paxi'
        ? L.paxiToRaw(amount)
        : L.tkccToRaw(amount, tkccInfo.decimals);
      await L.withdraw(token === 'paxi' ? null : tkccInfo.token, raw);
      log(T('msg.withdrawOk', { a: amount, t: token.toUpperCase() }));
      await refreshBalance();
      banner(T('msg.withdrawOkBanner'), 'info');
    } catch (e) { fail(e, T('err.withdraw')); }
  }

  // =====================================================================
  // 管理员动作
  // =====================================================================
  async function onSetTkcc() {
    try {
      const target = C.tkccToken;
      if (!target) return banner(T('msg.noTkccInConfig'), 'err');
      await L.setTkccToken(target);
      log(T('msg.tkccWritten', { addr: target }));
      await refreshTkcc(true);
      banner(T('msg.tkccEnabled'), 'info');
    } catch (e) { fail(e, T('err.enableTkcc')); }
  }

  /**
   * 管理员自动启用 TKCC：连接后若合约还没写入 TKCC 地址，自动发起一次。
   * 交易必须由钱包确认（无法真正静默），这里省掉的是"找按钮 + 点按钮"。
   * 只试一次，失败则提示去管理页手动点。
   */
  let autoTkccTried = false;
  async function autoEnableTkcc() {
    if (autoTkccTried || !C.autoEnableTkcc) return;
    if (!isAdmin || !K.wallet.address || tkccInfo.configured || !C.tkccToken) return;
    autoTkccTried = true;
    log(T('msg.tkccAutoStart'));
    try {
      await L.setTkccToken(C.tkccToken);
      log(T('msg.tkccAutoOk', { addr: C.tkccToken }));
      await refreshTkcc(true);
      banner(T('msg.tkccAutoOk', { addr: C.tkccToken }), 'info');
    } catch (e) {
      log(T('msg.tkccAutoFail') + ' (' + (e && e.message ? e.message : e) + ')');
      banner(T('msg.tkccAutoFail'), 'warn');
    }
  }
  async function onSetTreasury() {
    try {
      if (!C.treasury) return banner(T('msg.noTreasuryInConfig'), 'err');
      await L.setTreasury(C.treasury);
      log(T('msg.treasuryWritten', { v: C.treasury }));
      await refreshContractInfo();
    } catch (e) { fail(e, T('err.setTreasury')); }
  }
  async function onSetBurnMode() {
    try {
      const mode = $('burnMode').value;
      await L.setTkccBurnMode(mode);
      log(T('msg.burnModeSet', { m: mode }));
      await refreshTkcc(true);
    } catch (e) { fail(e, T('err.setBurnMode')); }
  }
  async function onSetBurn() {
    const address = $('burnAddr').value.trim();
    if (!address) return banner(T('msg.burnAddrRequired'), 'warn');
    try {
      await L.setTkccBurnAddress(address);
      log(T('msg.burnSet', { a: address }));
      await refreshTkcc(true);
    } catch (e) { fail(e, T('err.setBurn')); }
  }

  // =====================================================================
  // 事件绑定（全部走 guardBusy，防手机连点）
  // =====================================================================
  $('btnConnect').onclick  = () => guardBusy($('btnConnect'), () => onConnect());
  $('btnSession').onclick  = () => guardBusy($('btnSession'), () => onSession());
  $('btnCreate').onclick   = () => guardBusy($('btnCreate'), () => onCreate());
  $('btnDeposit').onclick  = () => guardBusy($('btnDeposit'), () => onDeposit());
  $('btnWithdraw').onclick = () => guardBusy($('btnWithdraw'), () => onWithdraw());
  $('btnRefresh').onclick  = () => refreshPools().catch((e) => banner(e.message || String(e), 'err'));
  $('fStatus').onchange    = () => refreshPools().catch(() => {});
  $('btnSetTkcc').onclick     = () => guardBusy($('btnSetTkcc'), () => onSetTkcc());
  $('btnSetTreasury').onclick = () => guardBusy($('btnSetTreasury'), () => onSetTreasury());
  $('btnSetBurnMode').onclick = () => guardBusy($('btnSetBurnMode'), () => onSetBurnMode());
  $('btnSetBurn').onclick     = () => guardBusy($('btnSetBurn'), () => onSetBurn());
  if (window.CJ_I18N) $('btnLang').onclick = () => window.CJ_I18N.toggle();

  // 语言切换：i18n.js 已自动套用静态 data-i18n 文案，这里重渲染动态内容
  // （卡片、横幅、倒计时、无感状态、TKCC 状态、费用框、档位卡片）
  window.addEventListener('lang-changed', () => {
    refreshSessionCard();
    refreshSessionStatus().catch(() => {});
    refreshTkcc(true).catch(() => {});
    updateCostBox();
    renderTierList();
    if (currentTab === 'pools')      refreshPools().catch(() => {});
    else if (currentTab === 'me')    refreshMyPage().catch(() => {});
    else if (currentTab === 'admin') refreshAdminPage().catch(() => {});
  });

  // =====================================================================
  // 初始化
  // =====================================================================
  parseSharedPool();
  renderTierList();
  refreshSessionCard();
  refreshSessionStatus().catch(() => {});
  updateCostBox();
  switchTab('pools');
  refreshTkcc(true).catch(() => {});

  const isWechat = /MicroMessenger/i.test(navigator.userAgent);
  if (isWechat) {
    setTimeout(() => {
      banner(T('msg.wechatTip'), 'warn');
    }, 1200);
  }

  // 轮询（仅前台 + 当前 tab）
  if (C.pollInterval > 0) {
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !K.wallet.address) return;
      if (currentTab === 'pools') refreshPools().catch(() => {});
      if (currentTab === 'me')    refreshMyPage().catch(() => {});
    }, C.pollInterval);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && K.wallet.address) {
      if (currentTab === 'pools') refreshPools().catch(() => {});
      if (currentTab === 'me')    refreshMyPage().catch(() => {});
    }
  });

  // ---------- PaxiHub 桥接异步注入 + 深链 ----------
  (async () => {
    const ok = await K.waitForWallet(6000);
    if (ok) { await onConnect().catch(() => {}); return; }

    // 已经在 PaxiHub 里（UA 或 bridge 残留）→ 不要再往外跳
    const inHub = /PaxiHub|paxihub/i.test(navigator.userAgent) || !!window.paxihub;
    if (inHub) {
      banner(T('msg.inHubWait'), 'warn');
      return;
    }

    if (/Mobi/i.test(navigator.userAgent)) {
      banner(T('msg.deepLinking'), 'warn');
      const b = $('banner');
      if (b) {
        b.style.cursor = 'pointer';
        b.onclick = () => {
          window.location.href = `paxi://hub/explorer?url=${encodeURIComponent(window.location.href)}`;
        };
      }

      let leftBrowser = false;
      const onVis = () => { if (document.hidden) leftBrowser = true; };
      document.addEventListener('visibilitychange', onVis);

      // 用隐藏 iframe 触发：未安装时 iOS 不会弹"无法打开页面"
      const deep = `paxi://hub/explorer?url=${encodeURIComponent(window.location.href)}`;
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'display:none;width:0;height:0;';
      ifr.src = deep;
      document.body.appendChild(ifr);
      setTimeout(() => { try { document.body.removeChild(ifr); } catch (_) {} }, 800);

      // 2.5s 后仍未离开浏览器 → 跳商店
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onVis);
        if (!leftBrowser) {
          window.location.href = 'https://paxinet.io/paxi_docs/paxihub#paxihub-application';
        }
      }, 2500);
    } else {
      banner(T('msg.notInHub'), 'warn');
    }
  })();
})();
