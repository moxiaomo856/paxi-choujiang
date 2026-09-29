/* =====================================================================
 * lottery.js —— 抽奖合约调用封装（纯查询 / 交易，不含 UI）
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;
  // 轻量翻译：i18n 就绪前回退原文（防止合约未加载时 t 不存在）
  const ti = (k, p) => (window.CJ_I18N ? window.CJ_I18N.t(k, p) : k);

  // ---------- 元信息 ----------
  async function tkcc() {
    return K.queryContract({ tkcc: {} });
  }

  async function config() {
    return K.queryContract({ lottery_config: {} });
  }

  async function contractConfig() {
    return K.queryContract({ config: {} });
  }

  async function resolveTkcc() {
    const info = await tkcc().catch(() => null);
    const token = (info && info.token) || C.tkccToken || '';
    let dec = (info && info.decimals != null) ? Number(info.decimals) : null;
    let symbol = 'TKCC';

    if (dec == null && token) {
      // ⚠️ 变量名不能叫 ti —— 会遮蔽外层翻译助手 ti()
      const tinfo = await tkccTokenInfo(token);
      if (tinfo) {
        if (tinfo.decimals != null) dec = Number(tinfo.decimals);
        if (tinfo.symbol) symbol = tinfo.symbol;
      }
    }
    if (dec == null) dec = C.tkccDecimals;

    return {
      token,
      decimals: dec,
      symbol,
      configured: !!(info && info.configured),
      burnMode: (info && info.burn_mode) || null,
      burnAddress: (info && info.burn_address) || null,
    };
  }

  async function tkccTokenInfo(token) {
    const addr = token || C.tkccToken;
    if (!addr) return null;
    return K.queryContract({ token_info: {} }, addr).catch(() => null);
  }

  function tkccToRaw(human, decimals) {
    return K.toRaw(human, decimals == null ? C.tkccDecimals : decimals);
  }
  function paxiToRaw(human) {
    return K.toRaw(human, C.coinDecimals);
  }

  // ---------- 查询 ----------
  const lottery = (id) => K.queryContract({ lottery: { id: Number(id) } });
  // start_after：合约支持游标分页，翻下一页时传上一页最后一个 id
  const lotteries = (status, limit = 30, startAfter = null) =>
    K.queryContract({ lotteries: { status: status || null, start_after: startAfter, limit } });
  const participants = (id) => K.queryContract({ participants: { id: Number(id) } });
  const winners = (id) => K.queryContract({ winners: { id: Number(id) } });
  const payout = (id) => K.queryContract({ payout: { id: Number(id) } });
  const unclaimed = (id) => K.queryContract({ unclaimed: { id: Number(id) } });
  const balance = (addr, token) => K.queryContract({ balance: { address: addr, token: token || null } });
  const balances = (addr) => K.queryContract({ balances: { address: addr } });

  // ---------- 交易 ----------
  async function depositPaxi(humanAmount) {
    const amount = paxiToRaw(humanAmount);
    return K.execute({ deposit: {} }, [{ denom: C.coinMinimalDenom, amount }], {
      gas: 400000,
      memo: 'deposit paxi',
    });
  }

  async function depositTkcc(humanAmount) {
    const { token, decimals } = await resolveTkcc();
    if (!token) throw new Error(ti('err.tkccNotConfiguredLottery'));
    const amount = tkccToRaw(humanAmount, decimals);
    // hook 走 UTF-8 字节再 base64，避免多字节内容出现编码歧义
    const hook = K.toBase64(new TextEncoder().encode(JSON.stringify({ deposit: {} })));
    return K.execute(
      { send: { contract: C.contract, amount, msg: hook } },
      [],
      { gas: 500000, contract: token, memo: 'deposit tkcc' }
    );
  }

  async function withdraw(token, rawAmount) {
    return K.execute({ withdraw: { token: token || null, amount: String(rawAmount) } }, [], {
      gas: 450000,
      memo: 'withdraw',
    });
  }

  /** 建池：只选档位，不带秘密（合约 commit_hash = null） */
  async function createLottery(opts) {
    const { tier } = opts;
    const t = C.tiers.find((x) => x.id === Number(tier));
    if (!t) throw new Error(ti('err.invalidTier'));
    const tkccInfo = await resolveTkcc();
    const feeTkccRaw = tkccToRaw(t.createTkcc, tkccInfo.decimals);
    const feePaxiRaw = paxiToRaw(t.createPaxi);
    const totalAmount = (BigInt(feeTkccRaw) + BigInt(feePaxiRaw)).toString();
    return K.execute(
      {
        create_lottery: {
          tier: Number(tier),
          commit_hash: null,
        },
      },
      [],
      {
        gas: 700000,
        session: { action: 'create_lottery', roundId: '0', amount: totalAmount },
        memo: 'create lottery',
      }
    );
  }

  /** 参与：joinTkccRaw / joinPaxiRaw 必须是链上 raw（用于无感签名原文） */
  async function joinLottery(id, joinTkccRaw, joinPaxiRaw) {
    const totalAmount = (BigInt(joinTkccRaw) + BigInt(joinPaxiRaw)).toString();
    return K.execute(
      { join_lottery: { id: Number(id) } },
      [],
      {
        gas: 600000,
        session: { action: 'join_lottery', roundId: String(id), amount: totalAmount },
        memo: 'join lottery',
      }
    );
  }

  const drawLottery = (id) =>
    K.execute({ draw_lottery: { id: Number(id) } }, [], { gas: 800000, memo: 'draw lottery' });

  const claim = (id) =>
    K.execute({ claim: { id: Number(id) } }, [], { gas: 500000, memo: 'claim prize' });

  const refund = (id) =>
    K.execute({ refund: { id: Number(id) } }, [], { gas: 500000, memo: 'refund' });

  // ---------- 管理员：TKCC 集成 ----------
  function setTkccToken(token) {
    const t = token || C.tkccToken;
    if (!t) throw new Error(ti('err.noTkccParam'));
    return K.execute({ admin: { set_tkcc_token: { token: t } } }, [], {
      gas: 300000, memo: 'set tkcc token',
    });
  }
  function setTkccBurnAddress(address) {
    if (!address) throw new Error(ti('msg.burnAddrRequired'));
    return K.execute({ admin: { set_tkcc_burn_address: { address } } }, [], {
      gas: 300000, memo: 'set tkcc burn address',
    });
  }
  function setTkccBurnMode(mode) {
    return K.execute({ admin: { set_tkcc_burn_mode: { mode } } }, [], {
      gas: 300000, memo: 'set tkcc burn mode',
    });
  }
  function setTreasury(treasury) {
    const t = treasury || C.treasury;
    if (!t) throw new Error(ti('err.noTreasuryParam'));
    return K.execute({ admin: { set_treasury: { treasury: t } } }, [], {
      gas: 300000, memo: 'set treasury',
    });
  }

  // ---------- 展示辅助 ----------
  const statusKeys = {
    open: 'status.open',
    full: 'status.full',
    drawn: 'status.drawn',
    refunded: 'status.refunded',
    cancelled: 'status.cancelled',
    expired: 'status.expired',
  };

  /** 状态文案：i18n 就绪时翻译，未就绪/未知状态回退原文 */
  function statusText(status) {
    const k = statusKeys[status] || '';
    return (k && window.CJ_I18N ? window.CJ_I18N.t(k) : '') || k || status || '';
  }

  /** 去掉小数末尾多余的 0：1.000000 → 1，4.003889 → 4.003889，27.062733 → 27.062733 */
  function trimZeros(s) {
    const t = String(s);
    if (t.indexOf('.') < 0) return t;
    return t.replace(/0+$/, '').replace(/\.$/, '');
  }

  /** 整数个数 → 中文「万」：10000 → 1万，15000 → 1.5万，9999 → 9,999
   *  英文环境下不用「万」，直接千分位显示 */
  function fmtWan(count) {
    let n;
    try { n = BigInt(String(Math.trunc(Number(count)) || 0)); } catch (_) { n = 0n; }
    const en = !!(window.CJ_I18N && window.CJ_I18N.getLang() === 'en');
    if (en) return Number(n).toLocaleString('en-US');
    if (n < 10000n) return Number(n).toLocaleString('zh-CN');
    const wan = n / 10000n;
    const rest = n % 10000n;
    if (rest === 0n) return wan.toLocaleString('zh-CN') + '万';
    // 保留两位小数再去掉多余的 0
    const frac = rest.toString().padStart(4, '0').slice(0, 2);
    return trimZeros(wan.toLocaleString('zh-CN') + '.' + frac) + '万';
  }

  /** PAXI：整数显示，无小数就不带 .000000 */
  function fmtPaxi(raw) { return trimZeros(K.fmt(raw, C.coinDecimals)); }

  /** TKCC：≥ 1 万走「万」，否则正常显示（都去掉多余 0） */
  function fmtTkcc(raw, decimals) {
    const d = decimals == null ? C.tkccDecimals : decimals;
    const full = trimZeros(K.fmt(raw, d));
    let intPart;
    try {
      intPart = BigInt(String(raw || '0')) / (10n ** BigInt(d));
    } catch (_) { return full; }
    if (intPart < 10000n) return full;
    return fmtWan(intPart.toString());
  }

  function toView(l, tkccDecimals) {
    const tier = C.tiers.find((t) => t.id === Number(l.tier));
    const expiresAt = Number(l.expires_at) * 1000;
    // 开奖后 pool_* 归零，历史奖池在 settled_pool_*
    const poolPaxiRaw = (l.settled_pool_paxi && l.settled_pool_paxi !== '0') ? l.settled_pool_paxi : l.pool_paxi;
    const poolTkccRaw = (l.settled_pool_tkcc && l.settled_pool_tkcc !== '0') ? l.settled_pool_tkcc : l.pool_tkcc;
    const expired = expiresAt < Date.now();
    // 统一派生"可操作状态"：链上 open 只代表"未开奖"，一个正在收人的池
    // 与一个时间到了、没满员、只能退款的死池，链上状态都是 open。
    // 这里把它俩拆开，让排序 / 徽章 / 退款按钮全部由同一份派生状态驱动，不再自相矛盾。
    const statusView = (l.status === 'open' && expired) ? 'expired' : l.status;
    return {
      id: l.id,
      creator: l.creator,
      tier: l.tier,
      tierLabel: tier ? tier.label : ti('common.tier') + l.tier,
      joinPaxi: fmtPaxi(l.join_paxi),
      joinPaxiRaw: l.join_paxi,
      joinTkcc: fmtTkcc(l.join_tkcc, tkccDecimals),
      joinTkccRaw: l.join_tkcc,
      maxPeople: l.max_people,
      // 开奖后 pool_* 归零，历史奖池在 settled_pool_*
      poolPaxi: fmtPaxi(poolPaxiRaw),
      poolTkcc: fmtTkcc(poolTkccRaw, tkccDecimals),
      // raw 值：UI 里算"预计一等奖"必须用它，
      // 用格式化字符串反解会把 fmtWan 的「万」算成 NaN
      poolPaxiRaw,
      poolTkccRaw,
      count: l.participant_count,
      status: l.status,            // 链上原始状态（退款判定 / 过滤仍用它）
      statusView,                  // 派生"可操作状态"（排序 + 徽章用）
      statusText: statusText(statusView),
      expired,
      expiresAt,
      expiresText: new Date(expiresAt).toLocaleString(
        window.CJ_I18N && window.CJ_I18N.getLang() === 'en' ? 'en-US' : 'zh-CN'
      ),
      winners: l.winners,
      payout: l.payout,
      seed: l.seed,
      randomSource: l.random_source,
      isTemplatePool: !!l.is_template_pool,
      templateId: l.template_id == null ? null : l.template_id,
    };
  }

  window.CJLottery = {
    tkcc, tkccTokenInfo, config, contractConfig, resolveTkcc,
    lottery, lotteries, participants, winners, payout, unclaimed, balance, balances,
    depositPaxi, depositTkcc, withdraw,
    createLottery, joinLottery, drawLottery, claim, refund,
    setTkccToken, setTkccBurnAddress, setTkccBurnMode, setTreasury,
    paxiToRaw, tkccToRaw, fmtPaxi, fmtTkcc, fmtWan, trimZeros, toView, statusText,
  };
})();
