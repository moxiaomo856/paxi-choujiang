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
  const _bannerKind = { _k: 'info' };  // 当前 banner 类型，防止轮询 refresh 冲掉用户错误提示
  const banner = (msg, kind) => {
    const el = $('banner');
    el.onclick = null;      // 清掉上一次挂的 onclick（深链分支挂的 paxi:// 跳转）
    el.style.cursor = '';   // 恢复默认光标
    if (!msg) {
      // O3：banner('') 只清 info 类（轮询用来消除"未配置"提示），
      // 不清 err / warn（用户操作失败的错误提示不应被轮询静默）。
      if (_bannerKind._k !== 'info') return;
      el.hidden = true;
      return;
    }
    _bannerKind._k = kind || 'info';
    el.hidden = false;
    el.className = 'banner ' + _bannerKind._k;
    el.textContent = msg;
  };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * 统一错误处理。
   * P1-1：需要会话签名却没开启时（err.needSession），顺便把「开启无感」按钮
   * 显示并高亮 —— 只给一句文字提示，用户还得自己在页面上找按钮，体验差。
   */
  function fail(e, prefix) {
    const msg = (e && e.message) ? e.message : String(e);
    if (e && e.needSession) {
      const b = $('btnSession');
      b.hidden = false;
      b.classList.add('primary');
      b.classList.remove('ghost');
      b.textContent = '开启无感';
    }
    log((prefix ? prefix + '：' : '') + msg);
    banner(msg, 'err');
  }

  // ---------- 通用复制（手机端刚需：长按选择长文本体验差）----------
  async function copyText(text, label) {
    const s = String(text == null ? '' : text);
    if (!s) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(s);
      } else {
        // 手机 WebView / 非 https 兜底
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      log('已复制' + (label ? ' ' + label : '') + '：' + s.slice(0, 16) + (s.length > 16 ? '…' : ''));
    } catch (e) {
      banner('复制失败，请长按手动选择', 'warn');
    }
  }
  // 生成可复制的 HTML 片段（渲染时套用即可）
  function copyable(text, label, display) {
    const t = String(text == null ? '' : text);
    const d = display == null ? t : String(display);
    return `<span class="copyable" title="点击复制 ${escapeHtml(label || '')}" `
      + `data-copy="${escapeHtml(t)}" data-copy-label="${escapeHtml(label || '')}">`
      + `${escapeHtml(d)}</span>`;
  }
  // 全局事件委托：任何 [data-copy] 元素被点击都触发复制
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-copy]');
    if (!el) return;
    e.preventDefault();
    copyText(el.dataset.copy, el.dataset.copyLabel || '');
  });

  let tkccInfo = { token: '', decimals: C.tkccDecimals, configured: false };
  let view = [];
  let isAdmin = false;
  let refreshing = false;
  let adminFromChain = false;
  let chainAdmins = [];
  let chainThreshold = 0;
  let templates = [];
  // 「确认强制揭示」状态（模板 id → 字符串 key）。存内存而非按钮 dataset：
  // refreshAll 会重建 tplList 的 DOM，dataset 会随轮询丢失。
  const revealForced = new Set();
  // 全部模板的元信息（id → PoolTemplate），供 renderList 判断官方池
  // 是否有承诺（无承诺模板的满员池只能等过期退款，提示要区分）。
  let tplMeta = {};

  // ---------- 钱包 / 会话 ----------
  async function onConnect() {
    const addr = await K.connect();
    // 成功连接后清掉此前遗留的错误/警告横幅。典型场景：钱包还没注入完成时
    // 手动点过"连接钱包"，报了"未检测到 PaxiHub 钱包"（err 类）；随后注入
    // 完成、连接成功，但 banner('') 按设计只清 info 类，err 会一直挂着误导用户。
    _bannerKind._k = 'info';
    banner('');
    $('addr').innerHTML = copyable(addr, '地址', addr.slice(0, 10) + '…' + addr.slice(-6));
    $('btnSession').hidden = false;
    // 依赖 CDN 的加密库自检：连上就先确认，避免"提交时才失败、分不清是 CDN 还是合约"
    if (!(window.CJHash && (await window.CJHash.ready()))) {
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
    banner(`无感已开启（${C.sessionTtlHours || 24} 小时）。期间切后台 / 锁屏不会失效；如需撤销请点"关闭无感"。`, 'info');
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
      if (!quiet) banner(e.message || String(e), 'err');
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
    // P2-2 修复：不再解析 Balances 列表猜 native key（旧代码假设 key 是空字符串，
    // 若 paxi_common::native_key() 非空串则 PAXI 余额恒显示 0）。
    // PAXI 直接用 token=null 查原生余额；TKCC 用显式 token 地址查，与 key 格式无关。
    try {
      const p = await L.balance(K.wallet.address, null);
      $('balPaxi').textContent = L.fmtPaxi(p.balance);
    } catch (e) { /* 忽略 */ }
    try {
      if (tkccInfo.token) {
        const t = await L.balance(K.wallet.address, tkccInfo.token);
        $('balTkcc').textContent = L.fmtTkcc(t.balance, tkccInfo.decimals);
      } else {
        $('balTkcc').textContent = '—';
      }
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
      // 官方池「进行中」的（open/full）由上方「官方奖池」区块展示；
      // 但满员（full）的官方池也要落到本列表：它正等待平台揭示 + 开奖，
      // 需要在这里显示"等待揭示"提示。已开奖的官方池同样保留在列表里，
      // 让用户看到历史中奖名单与开奖 seed。
      .filter((l) => !l.is_template_pool || l.status === 'drawn' || l.status === 'full')
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
      // P1-2：建池者不能参与自己的池（合约已直接拒绝）。这里不再给按钮，
      // 改为一行说明，避免用户点了才吃到 CreatorCannotJoin 报错。
      // 模板池的 creator 是合约自身地址，永远不会命中 isCreator。
      if (v.status === 'open' && !expired && !isCreator)
        acts.push(`<button class="btn sm" data-act="join" data-id="${v.id}">参与</button>`);
      // simple 版：只有满员才能开奖（合约无 min_people 分支），过期未满员只能退款。
      const canDraw = v.status === 'full' && !v.needsReveal;
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
      // 模板池专属提示：官方池没有"创建者"，揭示走"管理员 → 模板管理 →
      // 揭示下一个秘密"（存 TEMPLATE_SECRETS 查表，不用池子的 revealed 字段）。
      // needsReveal 对模板池恒为 false，所以这里用"full 但还没开奖"判断。
      // 模板池专属提示：按模板是否有承诺区分。
      // 无承诺模板的池子**永远无法开奖**（合约会报 TemplateCommitRequired），
      // 只能等过期退款 —— 文案必须如实，不能误导管理员去点一个点不动的揭示。
      // 模板是否有承诺：三态 —— true/false/null。
      // null = 模板元信息还没加载完（tplMeta 为空），此时**不能**默认当成
      // "有承诺"给"等待揭示"提示，也不能误报"无承诺只能退款"，给加载中提示。
      const tplHasCommit = v.templateId != null && tplMeta[v.templateId]
        ? !!tplMeta[v.templateId].has_commit : null;
      const tplRevealHint = (v.isTemplatePool && v.status === 'full' && !v.seed)
        ? (tplHasCommit === false
          ? `<div class="hint" style="color:var(--warn)">⚠️ 官方池（模板 ${v.templateId}）创建时未配置随机承诺，无法开奖；满员后只能等待过期退款。</div>`
          : tplHasCommit === true
            ? `<div class="hint">官方池（模板 ${v.templateId}）已满员，等待平台在「管理员 → 模板管理」揭示秘密后即可开奖。</div>`
            : `<div class="hint">官方池（模板 ${v.templateId}）已满员，正在加载模板信息…</div>`)
        : '';
      const creatorHint = (isCreator && v.status === 'open' && !expired)
        ? '<div class="hint">你建的池：建池者不能参与自己的池（已拿建池者分成）。</div>'
        : '';

      const fmtWin = (list) => (list || [])
        .map((a) => copyable(a, '地址', a.slice(0, 8) + '…' + a.slice(-4)))
        .join('、');
      const win = v.winners
        ? `<div class="win">一等奖：${fmtWin(v.winners.first)}<br/>二等奖：${fmtWin(v.winners.second)}</div>`
        : '';

      const poolTag = v.isTemplatePool
        ? `<span class="st platform">官方池 · 模板 ${v.templateId}</span>`
        : `<span class="st player">玩家建池</span>`;

      return `<div class="item">
        <div class="item-top">
          <span class="id">${copyable(String(v.id), '抽奖 ID', '#' + v.id)}</span>
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
        ${tplRevealHint}
        ${creatorHint}
      </div>`;
    }).join('');

    el.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => guardBusy(b, () => onAction(b.dataset.act, Number(b.dataset.id)));
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
            <div class="meta" style="opacity:.6;font-size:11px">🎲 随机源：平台托管秘密 + 参与者加入时间 + 区块熵（开奖前平台揭示，任何人可复算验证）</div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <div class="acts">
              <button class="btn sm primary" data-tpl="${e.template_id}">${full ? '开新池并参与' : '参与'}</button>
            </div>
          </div>`;
        }).join('')
      : '<p class="hint">暂无活跃模板，请联系管理员</p>';

    el.querySelectorAll('[data-tpl]').forEach((b) => {
      b.onclick = () => guardBusy(b, () => onActivate(Number(b.dataset.tpl)));
    });
  }

  async function onActivate(tid) {
    try {
      // P2-4 修复：签名金额改用**链上返回值**（activePoolOfTemplates 的 join_paxi /
      // join_tkcc 来自合约 tier_spec），不再用 config.js 的本地 tiers 表 ——
      // 合约按池子快照扣费，本地表与合约不同步时会导致签名验证失败且报错不可读。
      // activePoolOfTemplates 覆盖全部活跃模板（无活跃池也返回条目），故几乎总能命中；
      // 查询失败才回落本地表（与旧逻辑一致）。
      const res = await L.activePoolOfTemplates().catch(() => ({ entries: [] }));
      const entry = (res.entries || []).find((x) => x.template_id === Number(tid));
      let joinTkccCount, joinPaxiHuman;
      if (entry) {
        joinTkccCount = entry.join_tkcc;
        joinPaxiHuman = entry.join_paxi;
      } else {
        const tpl = await L.poolTemplate(tid);
        if (!tpl) return banner('模板不存在', 'err');
        const t = C.tiers.find((x) => x.id === Number(tpl.tier));
        if (!t) return banner('模板档位非法：' + tpl.tier, 'err');
        joinTkccCount = t.joinTkcc;
        joinPaxiHuman = t.joinPaxi;
      }
      const joinTkccRaw = L.tkccToRaw(joinTkccCount, tkccInfo.decimals);
      const joinPaxiRaw = L.paxiToRaw(joinPaxiHuman);
      await L.activateTemplate(tid, joinTkccRaw, joinPaxiRaw);
      log(`参与模板 #${tid} 成功`);
      await S.syncNonce();
      await refreshAll();
    } catch (e) {
      fail(e, '参与失败');
    }
  }

  async function refreshTemplates() {
    if (!isAdmin) return;
    const res = await L.poolTemplates().catch(() => ({ templates: [] }));
    templates = res.templates || [];
    $('tplList').innerHTML = templates.length
      ? templates.map((t) => {
          const tier = C.tiers.find((x) => x.id === Number(t.tier));
          const spec = tier ? tier : { label: '档位' + t.tier, joinPaxi: '?', joinTkcc: '?', people: '?' };
          const hasCommit = !!t.has_commit;
          const hasChain = !!localStorage.getItem('cj_tpl_chain_' + t.id);
          // 无承诺模板：合约端揭示必报 TemplateCommitRequired，按钮直接置灰，
          // 提示如实写"满员只能退款"，不给管理员一个点不动的假入口。
          const chainMeta = !hasCommit
            ? '<span style="color:var(--warn)">未配置随机承诺 —— 该模板的池子满员后只能等待过期退款</span>'
            : (hasChain ? '本机已有（可揭示）' : '⚠️ 本机没有（换设备会丢，丢失只能退款）');
          return `<div class="item">
          <div class="item-top"><span class="id">#${t.id} ${escapeHtml(t.name)}</span>
            <span class="st ${t.active ? 'open' : 'refunded'}">${t.active ? '启用' : '停用'}</span></div>
          <div class="meta">${escapeHtml(spec.label)} · 参与 ${spec.joinPaxi} PAXI + ${spec.joinTkcc} TKCC · ${spec.people} 人</div>
          <div class="meta" style="opacity:.6;font-size:11px">随机承诺：${chainMeta}</div>
          <div class="acts">
            <button class="btn sm ghost" data-toggle="${t.id}" data-active="${t.active}">${t.active ? '停用' : '启用'}</button>
            <button class="btn sm" data-reveal="${t.id}" ${hasCommit ? '' : 'disabled style="opacity:.45"'}>揭示下一个秘密</button>
          </div>
        </div>`;
        }).join('')
      : '<p class="hint">还没有模板</p>';
    $('tplList').querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => guardBusy(b, async () => {
        try {
          await L.updatePoolTemplate(Number(b.dataset.toggle), b.dataset.active !== 'true');
          log('模板状态已更新');
          await refreshAll();
        } catch (e) {
          fail(e, '更新失败');
        }
      });
    });
    $('tplList').querySelectorAll('[data-reveal]').forEach((b) => {
      b.onclick = () => guardBusy(b, async () => {
        try {
          // 两段式确认：第一次点击若活跃池未满员，revealTemplateSecret 抛
          // err.needForce（可能是旧满员池在等揭示，指针已被新池覆盖）。
          // 强制状态存**内存 Set** 而非按钮 dataset —— refreshAll 会重建
          // tplList 的 DOM，dataset 会被丢掉，8 秒轮询间隔正好卡在两次点击
          // 之间，用户会困惑"怎么又要点两下"。
          const forced = revealForced.has(b.dataset.reveal);
          await L.revealTemplateSecret(Number(b.dataset.reveal), forced);
          revealForced.delete(b.dataset.reveal);
          log('模板 #' + b.dataset.reveal + ' 已揭示下一个秘密');
          await refreshAll();
        } catch (e) {
          if (e && e.needForce) {
            revealForced.add(b.dataset.reveal);
            banner(e.message, 'warn');
            log('揭示被软拦截：' + (e.message || e));
            // 手动改当前按钮文案让用户立即看到状态变化（DOM 重建后由
            // revealForced.has() 在下一次渲染时还原为强制态文案）
            b.textContent = '确认强制揭示';
          } else {
            fail(e, '揭示失败');
          }
        }
      });
    });
  }

  async function onCreateTemplate() {
    try {
      const r = await L.createPoolTemplate($('tplName').value.trim(), $('tplTier').value);
      log('模板创建成功（#' + (r.tid || '?') + '），秘密链已存本机 localStorage，务必备份！');
      banner('模板创建成功。随机秘密链只保存在本机，请立即备份（丢失后官方池只能退款）。', 'warn');
      await refreshAll();
    } catch (e) {
      fail(e, '创建模板失败');
    }
  }

  // ---------- 动作 ----------
  // 手机端防双击（M-1）：触屏双击极容易误触发两次"参与/创建"，造成双倍扣费。
  // 全局交易锁：任何一笔交易在途时，拦截所有新的交易按钮；
  // chain.js 的 serializeTx 串行队列兜底 sequence，这里是 UX 层的第一道闸。
  let txBusy = false;
  async function guardBusy(btn, fn) {
    if (txBusy) {
      banner('上一笔交易还在处理中，请等它完成（可看下方日志）后再操作。', 'warn');
      return;
    }
    txBusy = true;
    const origText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '处理中…';
    }
    try {
      await fn();
    } finally {
      txBusy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText;
      }
    }
  }

  async function onAction(act, id) {
    try {
      if (act === 'join') {
        const v = view.find((x) => x.id === id);
        if (!v) return banner('奖池 #' + id + ' 不存在', 'err');
        const res = await L.joinLottery(id, v.joinTkccRaw, v.joinPaxiRaw);
        log(`参与 #${id} 成功${res.transactionHash || res.hash ? ' tx=' + (res.transactionHash || res.hash) : ''}`);
        await S.syncNonce();
      } else if (act === 'draw') {
        await L.drawLottery(id);
        log(`开奖 #${id} 成功`);
      } else if (act === 'claim') {
        await L.claim(id);
        log(`领取 #${id} 成功`);
      } else if (act === 'refund') {
        await L.refund(id);
        log(`退款 #${id} 成功`);
      } else if (act === 'reveal') {
        // 不再用 window.prompt（手机 WebView 常拦截 prompt），改页面内弹窗
        const saved = localStorage.getItem('cj_secret_' + id);
        $('revealLotteryId').textContent = id;
        $('revealSecret').value = saved || '';
        $('revealBox').hidden = false;
        $('revealHint').textContent = saved
          ? '秘密已自动带出；确认揭示或修改后点"确认揭示"。'
          : '未找到自动保存的秘密，请手动输入建池时填写的随机秘密。';
        // 预聚焦输入框让用户能立即改值
        setTimeout(() => $('revealSecret').focus({ preventScroll: true }), 50);
        return;  // 等用户点确认按钮
      }
      await refreshAll();
    } catch (e) {
      fail(e, '操作失败');
    }
  }

  async function onCreate() {
    try {
      const secret = $('fSecret').value.trim();
      // 承诺哈希依赖 CDN 加密库；库没加载就明确报出来，别让它伪装成"创建失败"
      if (secret && !(window.CJHash && (await window.CJHash.ready()))) {
        return banner('加密库未加载，无法计算承诺哈希。可把"秘密"留空直接创建，或检查网络后刷新重试。', 'err');
      }
      const commitHash = secret ? window.CJHash.sha256Hex(secret) : null;
      const res = await L.createLottery({
        tier: Number($('fTier').value),
        commitHash,
      });
      log('创建成功' + (res.transactionHash ? ' tx=' + res.transactionHash : ''));
      // lottery_id 主路径取 res.attributes（executeViaPaxihub 已用 extractWasmAttrs
      // 从事件提取，兼容顶层 events / logs / base64 key）；
      // 兜底对原始 tx_response 再提取一次，与主路径同一套兼容逻辑
      let id = res.attributes?.find((a) => a.key === 'lottery_id')?.value
        || K.extractWasmAttrs(res.raw || {}).find((a) => a.key === 'lottery_id')?.value;
      // #3：把 secret 存 localStorage，key = 'cj_secret_<lottery_id>'，
      // 这样 reveal 时才能按 id 正确带出（之前用 Date.now() 当 key 对不上）
      if (secret && id) {
        localStorage.setItem('cj_secret_' + id, secret);
      } else if (secret && !id) {
        // 合约 attributes 里没拿到 lottery_id（极少数情况：LCD 日志裁剪）
        // 这是可能丢钱的事，必须用 err 级别并写日志，不能随 warn 一闪而过
        banner(
          '⚠️ 创建成功，但未能自动保存"随机秘密"。请立即复制并妥善保存：' + secret
          + '（丢失后该池到期只能退款）',
          'err'
        );
        log('秘密未自动保存，请手动记录：' + secret);
      }
      await S.syncNonce();
      await refreshAll();
    } catch (e) {
      fail(e, '创建失败');
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
    if (refreshing) return;  // 防 setInterval / visibilitychange / btnRefresh 并发覆盖 session nonce
    refreshing = true;
    try {
      await refreshTkcc();
      await refreshBalance();
      // 模板元信息（含 has_commit）：公开查询，普通用户也需要 ——
      // renderList 靠它区分官方池"等待揭示"和"无承诺只能退款"。
      await L.poolTemplates().then((r) => {
        tplMeta = {};
        (r.templates || []).forEach((t) => { tplMeta[t.id] = t; });
      }).catch(() => {});
      await refreshTemplatePools().catch((e) => log('官方奖池刷新失败：' + e.message));
      await refreshList().catch((e) => log('列表刷新失败：' + e.message));
      if (isAdmin) {
        renderAdmins();
        await refreshContractInfo().catch((e) => log('运营配置刷新失败：' + e.message));
        await refreshTemplates().catch((e) => log('模板列表刷新失败：' + e.message));
      }
    } finally {
      refreshing = false;
    }
  }

  // ---------- 绑定 ----------
  $('btnConnect').onclick = () => onConnect().catch((e) => banner(e.message || String(e), 'err'));
  $('btnSession').onclick = () => guardBusy($('btnSession'), () => onSession().catch((e) => { banner(e.message || String(e), 'err'); }));
  $('btnCreate').onclick = () => guardBusy($('btnCreate'), onCreate);
  $('btnCreateTpl').onclick = () => guardBusy($('btnCreateTpl'), onCreateTemplate);
  $('btnSetTkcc').onclick = () => guardBusy($('btnSetTkcc'), onSetTkcc);
  $('btnSetBurnMode').onclick = () => guardBusy($('btnSetBurnMode'), onSetBurnMode);
  $('btnSetBurn').onclick = () => guardBusy($('btnSetBurn'), onSetBurn);
  $('btnSetTreasury').onclick = () => guardBusy($('btnSetTreasury'), onSetTreasury);
  $('btnDeposit').onclick = () => guardBusy($('btnDeposit'), onDeposit);
  $('btnWithdraw').onclick = () => guardBusy($('btnWithdraw'), onWithdraw);
  $('btnRefresh').onclick = () => refreshAll().catch((e) => banner(e.message || String(e), 'err'));
  $('fStatus').onchange = () => refreshList().catch((e) => banner(e.message || String(e), 'err'));

  // reveal 弹窗按钮（commit-reveal 抽奖）
  $('btnRevealCancel').onclick = () => { $('revealBox').hidden = true; };
  // 点遮罩区域关闭（modal 卡片内的点击不触发）
  $('revealBox').addEventListener('click', (e) => {
    if (e.target === $('revealBox')) $('revealBox').hidden = true;
  });
  $('btnRevealConfirm').onclick = () => guardBusy($('btnRevealConfirm'), async () => {
    const secret = $('revealSecret').value.trim();
    if (!secret) { banner('请填写随机秘密', 'warn'); return; }
    try {
      const nid = Number($('revealLotteryId').textContent);
      await L.revealSecret(nid, secret);
      log('揭示 #' + nid + ' 成功');
      localStorage.removeItem('cj_secret_' + nid);
      $('revealBox').hidden = true;
      await refreshAll();
    } catch (e) {
      log('揭示失败：' + (e.message || e));
      banner(e.message || String(e), 'err');
    }
  });

  // 三档下拉 + 档位费用提示（simple 版唯一入口）
  function fillTierSelect(sel, withCreateFee) {
    sel.innerHTML = C.tiers.map((t) =>
      `<option value="${t.id}">${t.label} · 参与 ${t.joinPaxi} PAXI + ${t.joinTkcc} TKCC`
      + (withCreateFee ? ` · 建池 ${t.createPaxi} PAXI + ${t.createTkcc} TKCC` : '')
      + `</option>`
    ).join('');
    sel.value = String(C.defaultTier || 0);
  }
  function tierHintText() {
    const t = C.tiers.find((x) => x.id === Number($('fTier').value)) || C.tiers[0];
    return `建池费 ${t.createPaxi} PAXI + ${t.createTkcc} TKCC（进奖池）；`
      + `${t.people} 人满员自动开奖，每人参与 ${t.joinPaxi} PAXI + ${t.joinTkcc} TKCC。`;
  }
  fillTierSelect($('fTier'), true);
  fillTierSelect($('tplTier'), false);
  const _updateTierHint = () => { $('tierHint').textContent = tierHintText(); };
  $('fTier').onchange = _updateTierHint;
  _updateTierHint();

  // 未连接钱包也先把 TKCC 地址 / 精度显示出来（只读查询，不需要钱包）
  refreshTkcc(true).catch(() => {});

  // #6：轮询 + 切回可见自动刷新（配置里 pollInterval 已声明）
  if (C.pollInterval > 0) {
    setInterval(() => {
      if (document.visibilityState === 'visible' && K.wallet.address) {
        refreshAll().catch(() => {});
      }
    }, C.pollInterval);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && K.wallet.address) {
      refreshAll().catch(() => {});
    }
  });

  // PaxiHub 的桥接是**异步注入**的：脚本执行时 window.paxihub 往往还没挂上，
  // 这时同步 K.hasWallet() 返回 false，会把 App 内的用户也当成"没钱包"而深链跳出去。
  // 必须先等待注入完成，确实等不到再走深链分支。
  (async () => {
    const ok = await K.waitForWallet(6000);
    if (ok) {
      await onConnect().catch(() => {});
      return;
    }

    // 已经在 PaxiHub 里（UA 或 bridge 残留），不要再往外跳
    const inHub = /PaxiHub|paxihub/i.test(navigator.userAgent) || !!window.paxihub;
    if (inHub) {
      banner('PaxiHub 已检测到，但钱包桥接尚未就绪。请稍等片刻后下拉刷新，或从 PaxiHub 重新打开本页。', 'warn');
      return;
    }

    if (/Mobi/i.test(navigator.userAgent)) {
      banner('正在唤起 PaxiHub App…若未安装将跳转下载页。', 'warn');
      const b = document.getElementById('banner');
      if (b) {
        b.style.cursor = 'pointer';
        b.onclick = () => {
          window.location.href = `paxi://hub/explorer?url=${encodeURIComponent(window.location.href)}`;
        };
      }

      let leftBrowser = false;
      const onVis = () => { if (document.hidden) leftBrowser = true; };
      document.addEventListener('visibilitychange', onVis);

      // 用隐藏 iframe 触发，避免未安装时 iOS 弹"无法打开页面"
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
      // 纯手机项目：桌面浏览器没有 PaxiHub（它只有手机版），
      // 桌面端不再引导"去装钱包"，而是引导扫码把页面转移到手机 PaxiHub。
      banner('PaxiHub 只有手机版。请用手机扫描下方二维码，在 PaxiHub App 内打开本页面。', 'warn');
      showDesktopQr();
    }
  })();

  /** 桌面端引导卡片：二维码 + 链接（手机端永远不会走到这里） */
  function showDesktopQr() {
    if (document.getElementById('qrCard')) return;
    const app = document.querySelector('.app');
    const card = document.createElement('div');
    card.id = 'qrCard';
    card.className = 'card';
    card.innerHTML =
      '<h2>📱 在手机 PaxiHub 中打开</h2>'
      + '<p class="hint">用手机相机 / 浏览器扫描下方二维码（或在手机浏览器打开下面的链接），'
      + '页面会自动唤起 PaxiHub App。</p>'
      + '<div id="qrBox" class="qr-box">二维码加载中…</div>'
      + '<p class="hint" style="word-break:break-all;user-select:text;-webkit-user-select:text">'
      + escapeHtml(location.href) + '</p>';
    const firstCard = app.querySelector('.card');
    if (firstCard) app.insertBefore(card, firstCard);
    else app.appendChild(card);

    // qrcodejs（UMD，仅桌面引导用；手机端不加载）。
    // 固定版本号，不用 @master —— 主分支变动会让线上二维码突然坏掉
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
    s.onload = () => {
      const box = card.querySelector('#qrBox');
      box.textContent = '';
      try {
        new QRCode(box, {
          text: location.href,
          width: 220,
          height: 220,
          correctLevel: QRCode.CorrectLevel.M,
        });
      } catch (e) {
        box.textContent = '二维码生成失败，请手动复制上方链接到手机打开';
      }
    };
    s.onerror = () => {
      card.querySelector('#qrBox').textContent = '二维码库加载失败，请手动复制上方链接到手机打开';
    };
    document.head.appendChild(s);
  }
})();
