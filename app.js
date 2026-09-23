/* =====================================================================
 * app.js —— 抽奖前端 UI 逻辑
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;
  const S = window.CJSession;
  const L = window.CJLottery;

  const $ = (id) => document.getElementById(id);
  const log = (msg) => {
    const el = $('log');
    el.textContent = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}\n` + el.textContent;
  };
  const banner = (msg, kind) => {
    const el = $('banner');
    if (!msg) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'banner ' + (kind || 'info');
    el.textContent = msg;
  };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let tkccInfo = { token: '', decimals: C.tkccDecimals, configured: false };
  let view = [];
  let isAdmin = false;
  let adminFromChain = false;
  let chainAdmins = [];
  let chainThreshold = 0;
  let templates = [];

  // ---------- 钱包 / 会话 ----------
  async function onConnect() {
    const addr = await K.connect();
    $('addr').textContent = addr.slice(0, 10) + '…' + addr.slice(-6);
    $('btnSession').hidden = false;
    // 依赖 CDN 的加密库自检：连上就先确认，避免"提交时才失败、分不清是 CDN 还是合约"
    if (!(window.CJHash && window.CJHash.ready())) {
      banner('加密库（@noble/secp256k1 / @noble/hashes / bech32）未加载成功：无感会话与"承诺哈希"将不可用。请确认网络能访问 CDN 后刷新页面。', 'warn');
    }
    if (S.restore()) {
      await S.syncNonce();
      if (S.state.enabled) {
        $('sessTag').hidden = false;
        $('btnSession').textContent = '关闭无感';
      } else {
        $('sessTag').hidden = true;
        $('btnSession').textContent = '开启无感';
        log('无感会话已失效，请重新开启');
      }
    }
    await detectAdmin();
    await refreshAll();
    log('已连接 ' + addr);
  }

  /** 是否为管理员（决定是否显示管理面板）
   *  优先用链上 {"admins":{}}；合约未部署 / 查询失败时回落到 config.js 的 admins 白名单 */
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
    $('adminPanel').hidden = !isAdmin;
    // P3-3：管理员面板的渲染统一交给紧接着的 refreshAll()（它已含 renderAdmins /
    // refreshContractInfo / refreshTemplates），此处不再重复，避免 renderAdmins 连调两次。
  }

  /** 展示管理员白名单（链上优先） */
  function renderAdmins() {
    const list = adminFromChain && chainAdmins.length ? chainAdmins : (C.admins || []);
    $('adminsStatus').textContent =
      `管理员（${adminFromChain ? '链上' : 'config.js 兜底'}，阈值 ${chainThreshold || C.multisigThreshold}）：`
      + (list.length ? list.join('、') : '—');
  }

  /** 合约级配置（运营金库 / 暂停状态） */
  async function refreshContractInfo() {
    try {
      const cfg = await L.contractConfig();
      const t = cfg.treasury || '';
      const match = t === C.treasury;
      $('treasuryStatus').textContent =
        `运营金库（链上）：${t || '—'}`
        + (t && !match ? ` · config.js 里是 ${C.treasury}（可点下方写入）` : '')
        + (cfg.paused ? ' · ⚠️ 合约已暂停' : '');
      $('btnSetTreasury').textContent = match ? '运营金库一致（可重写）' : '写入运营金库';
      $('btnSetTreasury').classList.toggle('ghost', match);
    } catch (e) {
      $('treasuryStatus').textContent = `运营金库（config.js，合约未就绪）：${C.treasury}`;
    }
  }

  /** 管理员：把 config.js 的运营金库写进合约 */
  async function onSetTreasury() {
    try {
      if (!C.treasury) return banner('config.js 里没有 treasury 地址', 'err');
      await L.setTreasury(C.treasury);
      log('已写入运营金库：' + C.treasury);
      await refreshContractInfo();
    } catch (e) {
      log('写入运营金库失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  async function onSession() {
    if (S.state.enabled) {
      S.clear();
      $('sessTag').hidden = true;
      $('btnSession').textContent = '开启无感';
      log('已关闭无感');
      return;
    }
    const a = await S.enable();
    $('sessTag').hidden = false;
    $('btnSession').textContent = '关闭无感';
    log('无感已开启：' + a);
  }

  // ---------- 数据 ----------
  /** 刷新 TKCC 元信息；quiet=true 时不改顶部横幅（用于未连接钱包的初始渲染） */
  async function refreshTkcc(quiet) {
    try {
      tkccInfo = await L.resolveTkcc();
      $('balTkccLabel').textContent = tkccInfo.symbol || 'TKCC';
      $('tkccStatus').textContent = tkccInfo.token
        ? `TKCC 合约：${tkccInfo.token}（${tkccInfo.symbol}，decimals ${tkccInfo.decimals}）· 合约内已启用：${tkccInfo.configured ? '是' : '否'}`
        : 'TKCC 合约：config.js 未配置';

      // 当前销毁配置回填（管理员面板）
      if (tkccInfo.burnMode) $('burnMode').value = tkccInfo.burnMode;
      if (tkccInfo.burnAddress && !$('burnAddr').value) $('burnAddr').value = tkccInfo.burnAddress;

      // 管理员：合约还没写入 TKCC 时高亮按钮
      const btn = $('btnSetTkcc');
      btn.textContent = tkccInfo.configured ? '重新写入 TKCC 地址' : '启用 TKCC（写入合约）';
      btn.classList.toggle('ghost', tkccInfo.configured);
      btn.classList.toggle('primary', !tkccInfo.configured);

      if (quiet) return;
      if (tkccInfo.configured) {
        banner('');
      } else if (isAdmin && tkccInfo.token) {
        banner('本合约尚未启用 TKCC。你是管理员，点上方「启用 TKCC」写入地址即可启用全部 TKCC 功能。', 'warn');
      } else {
        banner('TKCC 尚未配置：创建 / 参与抽奖会返回 TkccNotConfigured。管理员 SetTkccToken 后自动启用。', 'warn');
      }
    } catch (e) {
      if (!quiet) banner(e.message, 'err');
    }
  }

  /** 管理员：把 config.js 里的 TKCC 地址写进合约 */
  async function onSetTkcc() {
    try {
      // 要"写入合约"的地址一律取 config.js；`tkccInfo.token` 可能是**链上已配置**的值，
      // 两者来源不同，不能拿它来判断 config.js 是否为空（否则会给出误导性提示）。
      const target = C.tkccToken;
      if (!target) {
        return banner('config.js 里未配置 tkccToken，无法写入合约'
          + (tkccInfo.token ? `（链上当前是 ${tkccInfo.token}）` : ''), 'err');
      }
      await L.setTkccToken(target);
      log('已写入 TKCC 地址：' + target);
      await refreshAll();
    } catch (e) {
      log('启用 TKCC 失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  /** 管理员：设置 TKCC 销毁方式（burn / black_hole / skip） */
  async function onSetBurnMode() {
    const mode = $('burnMode').value;
    try {
      await L.setTkccBurnMode(mode);
      log('已设置销毁方式：' + mode);
      await refreshAll();
    } catch (e) {
      log('设置销毁方式失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  /** 管理员：设置 TKCC 销毁黑洞地址 */
  async function onSetBurn() {
    const address = $('burnAddr').value.trim();
    if (!address) return banner('请填写销毁黑洞地址', 'warn');
    try {
      await L.setTkccBurnAddress(address);
      log('已设置销毁黑洞：' + address);
      await refreshAll();
    } catch (e) {
      log('设置黑洞失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  async function refreshBalance() {
    if (!K.wallet.address) return;
    try {
      const bs = await L.balances(K.wallet.address);
      const map = Object.fromEntries((bs.balances || []).map(([t, a]) => [t === '' ? 'paxi' : t, a]));
      $('balPaxi').textContent = L.fmtPaxi(map.paxi || '0');
      $('balTkcc').textContent = tkccInfo.token ? L.fmtTkcc(map[tkccInfo.token] || '0', tkccInfo.decimals) : '—';
    } catch (e) { /* 忽略 */ }
    try {
      const bank = await K.getBankBalances(K.wallet.address);
      const p = bank.find((b) => b.denom === C.coinMinimalDenom);
      $('bankPaxi').textContent = L.fmtPaxi(p ? p.amount : '0');
    } catch (e) { /* 忽略 */ }
  }

  async function refreshList() {
    const status = $('fStatus').value || null;
    const res = await L.lotteries(status, 30);
    view = (res.lotteries || [])
      // P3-2：官方池「进行中」的（open/full）由上方「官方奖池」区块展示；
      // 已开奖的官方池（开奖后合约已移除 ACTIVE_POOL_OF_TEMPLATE）落到本列表，
      // 让用户仍能看到历史中奖名单与开奖 seed，且与上方区块不重复。
      .filter((l) => !l.is_template_pool || l.status === 'drawn')
      .map((l) => L.toView(l, tkccInfo.decimals));
    renderList();
  }

  function renderList() {
    const el = $('list');
    if (!view.length) { el.innerHTML = '<p class="hint">暂无抽奖</p>'; return; }
    el.innerHTML = view.map((v) => {
      const pct = v.maxPeople ? Math.min(100, Math.round((v.count / v.maxPeople) * 100)) : 0;
      const isCreator = K.wallet.address && v.creator === K.wallet.address;
      const expired = Date.now() > v.expiresAt;
      const acts = [];
      if (v.status === 'open' && !expired) acts.push(`<button class="btn sm" data-act="join" data-id="${v.id}">参与</button>`);
      // N11：创建者承诺过但未揭示时，合约会拒绝开奖
      //（未到期 → CommitMismatch；已到期 → CommitNotRevealed），
      // 所以这里不再给出"开奖"按钮，改为提示，避免用户点了才报错。
      const canDraw = (v.status === 'full' || (expired && v.count >= v.minPeople))
        && v.status !== 'drawn' && !v.needsReveal;
      if (canDraw)
        acts.push(`<button class="btn sm primary" data-act="draw" data-id="${v.id}">开奖</button>`);
      if (v.status === 'drawn') acts.push(`<button class="btn sm primary" data-act="claim" data-id="${v.id}">领取</button>`);
      if (expired && v.status !== 'drawn' && v.status !== 'refunded')
        acts.push(`<button class="btn sm ghost" data-act="refund" data-id="${v.id}">退款</button>`);
      if (v.needsReveal && isCreator)
        acts.push(`<button class="btn sm ghost" data-act="reveal" data-id="${v.id}">揭示秘密</button>`);
      // 提示类内容不放 acts（那是按钮容器），单独渲染在按钮区下面；
      // 用 warn 色提示，避免与其他 muted 的 .hint 混为一谈
      const revealHint = (v.needsReveal && v.status !== 'drawn' && v.status !== 'refunded')
        ? '<div class="hint" style="color:var(--warn)">⚠️ 创建者未揭示秘密，暂不能开奖；到期后可退款</div>'
        : '';

      const win = v.winners
        ? `<div class="win">一等奖：${(v.winners.first || []).join(', ')}<br/>二等奖：${(v.winners.second || []).join(', ')}</div>`
        : '';

      const poolTag = v.isTemplatePool
        ? `<span class="st platform">官方池 · 模板 ${v.templateId}</span>`
        : `<span class="st player">玩家建池</span>`;

      return `<div class="item">
        <div class="item-top">
          <span class="id">#${v.id}</span>
          <span class="st ${v.status}">${v.statusText}</span>
          ${poolTag}
          ${isCreator ? '<span class="st mine">我建的</span>' : ''}
        </div>
        <div class="meta">参与费 ${v.joinPaxi} PAXI + ${v.joinTkcc} TKCC · 奖池 ${v.poolPaxi} PAXI / ${v.poolTkcc} TKCC</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="meta">${v.count} / ${v.maxPeople} 人 · 截止 ${v.expiresText}${v.randomSource ? ' · 随机源 ' + v.randomSource : ''}</div>
        ${win}
        <div class="acts">${acts.join('')}</div>
        ${revealHint}
      </div>`;
    }).join('');

    el.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => onAction(b.dataset.act, Number(b.dataset.id));
    });
  }

  // ---------- 官方模板池（B2）----------
  async function refreshTemplatePools() {
    if (!C.showTemplatePools) { $('templateSection').hidden = true; return; }
    const res = await L.activePoolOfTemplates().catch(() => ({ entries: [] }));
    const entries = res.entries || [];
    const el = $('templatePools');
    el.innerHTML = entries.length
      ? entries.map((e) => {
          const pct = e.max_people ? Math.min(100, Math.round((e.participant_count / e.max_people) * 100)) : 0;
          const full = e.participant_count >= e.max_people;
          const feeTkcc = L.fmtTkcc(L.tkccToRaw(e.join_tkcc, tkccInfo.decimals), tkccInfo.decimals);
          return `<div class="item">
            <div class="item-top">
              <span class="id">${escapeHtml(e.template_name)}</span>
              <span class="st ${full ? 'full' : 'open'}">${full ? '已满，将开新池' : '报名中'}</span>
            </div>
            <div class="meta">参与费 ${L.fmtPaxi(e.join_paxi)} PAXI + ${feeTkcc} TKCC</div>
            <div class="meta">${e.participant_count} / ${e.max_people} 人</div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <div class="acts">
              <button class="btn sm primary" data-tpl="${e.template_id}">${full ? '开新池并参与' : '参与'}</button>
            </div>
          </div>`;
        }).join('')
      : '<p class="hint">暂无活跃模板，请联系管理员</p>';

    el.querySelectorAll('[data-tpl]').forEach((b) => {
      b.onclick = () => onActivate(Number(b.dataset.tpl));
    });
  }

  async function onActivate(tid) {
    try {
      const tpl = await L.poolTemplate(tid);
      if (!tpl) return banner('模板不存在', 'err');
      // ⚠️ 模板的两个参与费单位**不对称**（与池子不同，池子两个都是 raw）：
      //    tpl.join_paxi 已是 raw；tpl.join_tkcc 是"个数"，必须 tkccToRaw 转 raw。
      //    换算成 raw 后，amount = paxiRaw + tkccRaw 才是合约端 join_pool_internal 的签名原文。
      const joinTkccRaw = L.tkccToRaw(tpl.join_tkcc, tkccInfo.decimals);
      const joinPaxiRaw = tpl.join_paxi; // 已是 raw（创建时 paxiToRaw 过）
      await L.activateTemplate(tid, joinTkccRaw, joinPaxiRaw);
      log(`参与模板 #${tid} 成功`);
      await S.syncNonce();
      await refreshAll();
    } catch (e) {
      log('参与失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
      S.rollbackNonce();
    }
  }

  async function refreshTemplates() {
    if (!isAdmin) return;
    const res = await L.poolTemplates().catch(() => ({ templates: [] }));
    templates = res.templates || [];
    $('tplList').innerHTML = templates.length
      ? templates.map((t) => `<div class="item">
          <div class="item-top"><span class="id">#${t.id} ${escapeHtml(t.name)}</span>
            <span class="st ${t.active ? 'open' : 'refunded'}">${t.active ? '启用' : '停用'}</span></div>
          <div class="meta">参与费 ${L.fmtPaxi(t.join_paxi)} PAXI + ${t.join_tkcc} TKCC · ${t.min_people}–${t.max_people} 人</div>
          <div class="acts"><button class="btn sm ghost" data-toggle="${t.id}" data-active="${t.active}">${t.active ? '停用' : '启用'}</button></div>
        </div>`).join('')
      : '<p class="hint">还没有模板</p>';
    $('tplList').querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        try {
          await L.updatePoolTemplate(Number(b.dataset.toggle), b.dataset.active !== 'true');
          log('模板状态已更新');
          await refreshAll();
        } catch (e) {
          log('更新失败：' + (e.message || e));
          banner(e.message || String(e), 'err');
        }
      };
    });
  }

  async function onCreateTemplate() {
    try {
      await L.createPoolTemplate(
        $('tplName').value.trim(),
        $('tplJoinPaxi').value,
        $('tplJoinTkcc').value,
        $('tplMin').value,
        $('tplMax').value
      );
      log('模板创建成功');
      await refreshAll();
    } catch (e) {
      log('创建模板失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  // ---------- 动作 ----------
  async function onAction(act, id) {
    try {
      if (act === 'join') {
        const v = view.find((x) => x.id === id);
        const res = await L.joinLottery(id, v.joinTkccRaw, v.joinPaxiRaw);
        log(`参与 #${id} 成功 tx=${res.transactionHash || res.hash || ''}`);
        await S.syncNonce();
      } else if (act === 'draw') {
        const res = await L.drawLottery(id);
        log(`开奖 #${id} 成功`);
      } else if (act === 'claim') {
        await L.claim(id);
        log(`领取 #${id} 成功`);
      } else if (act === 'refund') {
        await L.refund(id);
        log(`退款 #${id} 成功`);
      } else if (act === 'reveal') {
        const secret = prompt('请输入建池时填写的随机秘密：');
        if (!secret) return;
        await L.revealSecret(id, secret);
        log(`揭示 #${id} 成功`);
      }
      await refreshAll();
    } catch (e) {
      log('失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
      if (act === 'join') S.rollbackNonce();
    }
  }

  async function onCreate() {
    try {
      const secret = $('fSecret').value.trim();
      // 承诺哈希依赖 CDN 加密库；库没加载就明确报出来，别让它伪装成"创建失败"
      if (secret && !(window.CJHash && window.CJHash.ready())) {
        return banner('加密库未加载，无法计算承诺哈希。可把"秘密"留空直接创建，或检查网络后刷新重试。', 'err');
      }
      const commitHash = secret ? window.CJHash.sha256Hex(secret) : null;
      const res = await L.createLottery({
        joinPaxi: $('fJoinPaxi').value,
        joinTkcc: $('fJoinTkcc').value,
        minPeople: $('fMin').value,
        maxPeople: $('fMax').value,
        commitHash,
      });
      log('创建成功 ' + (res.transactionHash || ''));
      if (secret) localStorage.setItem('cj_secret_' + Date.now(), secret);
      await S.syncNonce();
      await refreshAll();
    } catch (e) {
      log('创建失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
      S.rollbackNonce();
    }
  }

  async function onDeposit() {
    const amount = $('depAmount').value;
    const token = $('depToken').value;
    if (!amount || Number(amount) <= 0) return banner('请输入数量', 'warn');
    try {
      if (token === 'paxi') await L.depositPaxi(amount);
      else await L.depositTkcc(amount);
      log(`充值 ${amount} ${token.toUpperCase()} 成功`);
      await refreshBalance();
    } catch (e) {
      log('充值失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  async function onWithdraw() {
    const amount = $('depAmount').value;
    const token = $('depToken').value;
    if (!amount || Number(amount) <= 0) return banner('请输入数量', 'warn');
    try {
      const raw = token === 'paxi'
        ? L.paxiToRaw(amount)
        : L.tkccToRaw(amount, tkccInfo.decimals);
      await L.withdraw(token === 'paxi' ? null : tkccInfo.token, raw);
      log(`提现 ${amount} ${token.toUpperCase()} 成功`);
      await refreshBalance();
    } catch (e) {
      log('提现失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  }

  async function refreshAll() {
    await refreshTkcc();
    await refreshBalance();
    await refreshTemplatePools().catch((e) => log('官方奖池刷新失败：' + e.message));
    await refreshList().catch((e) => log('列表刷新失败：' + e.message));
    if (isAdmin) {
      renderAdmins();
      await refreshContractInfo().catch((e) => log('运营配置刷新失败：' + e.message));
      await refreshTemplates().catch((e) => log('模板列表刷新失败：' + e.message));
    }
  }

  // ---------- 绑定 ----------
  $('btnConnect').onclick = () => onConnect().catch((e) => banner(e.message, 'err'));
  $('btnSession').onclick = () => onSession().catch((e) => banner(e.message, 'err'));
  $('btnCreate').onclick = onCreate;
  $('btnCreateTpl').onclick = onCreateTemplate;
  $('btnSetTkcc').onclick = onSetTkcc;
  $('btnSetBurnMode').onclick = onSetBurnMode;
  $('btnSetBurn').onclick = onSetBurn;
  $('btnSetTreasury').onclick = onSetTreasury;
  $('btnDeposit').onclick = onDeposit;
  $('btnWithdraw').onclick = onWithdraw;
  $('btnRefresh').onclick = () => refreshAll().catch((e) => banner(e.message, 'err'));
  $('fStatus').onchange = () => refreshList().catch((e) => banner(e.message, 'err'));

  // 自动填充业务默认值
  $('fJoinPaxi').value = C.joinPaxiMin;
  $('fJoinTkcc').value = C.joinTkccMin;
  $('fMin').value = C.defaultPeople;
  $('fMax').value = C.peopleMax;
  $('fHours').value = C.durationHours;

  // 未连接钱包也先把 TKCC 地址 / 精度显示出来（只读查询，不需要钱包）
  refreshTkcc(true).catch(() => {});

  if (K.hasWallet()) onConnect().catch(() => {});
  else banner('未检测到 Paxi 钱包，请在钱包 App 内置浏览器打开', 'warn');
})();
