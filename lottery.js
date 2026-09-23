/* =====================================================================
 * lottery.js —— 抽奖合约调用封装（纯查询 / 交易，不含 UI）
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;

  // ---------- 元信息 ----------
  /** TKCC 配置（外部 PRC-20，可能尚未配置） */
  async function tkcc() {
    return K.queryContract({ tkcc: {} });
  }

  async function config() {
    return K.queryContract({ lottery_config: {} });
  }

  async function contractConfig() {
    return K.queryContract({ config: {} });
  }

  /** 运行期解析 TKCC 地址与精度（优先用合约返回值） */
  async function resolveTkcc() {
    const info = await tkcc().catch(() => null);
    const token = (info && info.token) || C.tkccToken || '';
    let dec = (info && info.decimals != null) ? Number(info.decimals) : null;
    let symbol = 'TKCC';

    // 合约还没 SetTkccToken 时，直接用 config 里的地址去问代币合约，
    // 这样前端在管理员启用之前就能显示 TKCC 余额与精度。
    if (dec == null && token) {
      const ti = await tkccTokenInfo(token);
      if (ti) {
        if (ti.decimals != null) dec = Number(ti.decimals);
        if (ti.symbol) symbol = ti.symbol;
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

  /** 直接查询 TKCC 代币合约的 token_info（name / symbol / decimals / total_supply） */
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
  const lotteries = (status, limit = 30) => K.queryContract({ lotteries: { status: status || null, start_after: null, limit } });
  const participants = (id) => K.queryContract({ participants: { id: Number(id) } });
  const winners = (id) => K.queryContract({ winners: { id: Number(id) } });
  const payout = (id) => K.queryContract({ payout: { id: Number(id) } });
  const balance = (addr, token) => K.queryContract({ balance: { address: addr, token: token || null } });
  const balances = (addr) => K.queryContract({ balances: { address: addr } });

  // ---------- B2 平台模板池：查询 ----------
  const poolTemplates = () => K.queryContract({ pool_templates: {} });
  const poolTemplate = (id) => K.queryContract({ pool_template: { id: Number(id) } });
  const activePoolOfTemplates = () => K.queryContract({ active_pool_of_templates: {} });

  // ---------- 交易 ----------
  /** 充值 PAXI 到内部余额 */
  async function depositPaxi(humanAmount) {
    const amount = paxiToRaw(humanAmount);
    return K.execute({ deposit: {} }, [{ denom: C.coinMinimalDenom, amount }], {
      gas: 400000,
      memo: 'deposit paxi',
    });
  }

  /** 充值 TKCC：在 TKCC 合约调用 send，触发本合约的 receive 钩子 */
  async function depositTkcc(humanAmount) {
    const { token, decimals } = await resolveTkcc();
    if (!token) throw new Error('TKCC 未配置（合约尚未 SetTkccToken）');
    const amount = tkccToRaw(humanAmount, decimals);
    const hook = K.toBase64(JSON.stringify({ deposit: {} }));
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

  /**
   * 建池（走无感签名）。
   * amount 进签名原文 = PAXI 建池费 + TKCC 建池费 的 raw 总和，
   * 必须与合约端一致（合约用 create_fee_paxi + to_tkcc_units(create_fee_tkcc)），
   * 否则签名验证失败，且 PAXI 建池费会绕过会话日限额（HIGH-1）。
   */
  async function createLottery(opts) {
    const { joinPaxi, joinTkcc, minPeople, maxPeople, commitHash } = opts;
    const tkccInfo = await resolveTkcc();
    // amount = PAXI 费 + TKCC 费（raw 总和），覆盖本次全部资金流出
    const feeTkccRaw = tkccToRaw(C.createFeeTkcc, tkccInfo.decimals);
    const feePaxiRaw = paxiToRaw(C.createFeePaxi);
    const totalAmount = (BigInt(feeTkccRaw) + BigInt(feePaxiRaw)).toString();
    return K.execute(
      {
        create_lottery: {
          join_paxi: paxiToRaw(joinPaxi),
          // ⚠️ `join_tkcc` 的语义是「TKCC 个数」，与合约端 `cfg.min/max_join_tkcc`
          //（1万–10万，均为个数）的范围判断一致；合约内部才会 to_tkcc_units 转 raw。
          // 历史 bug：这里曾误用 tkccToRaw()，10000 → 10^10 >> max=100000，
          // 导致 A 模式建池必然报 JoinFeeOutOfRange（B2 模板的 createPoolTemplate 是对的）。
          join_tkcc: String(joinTkcc),
          min_people: Number(minPeople),
          max_people: Number(maxPeople),
          commit_hash: commitHash || null,
        },
      },
      [],
      { gas: 700000, session: { action: 'create_lottery', roundId: '0', amount: totalAmount }, memo: 'create lottery' }
    );
  }

  /**
   * 参与抽奖（A 模式主入口；B2 模式经 activateTemplate 间接走合约同一入口）。
   * amount 进签名原文 = PAXI + TKCC 的 raw 总和，必须与合约端 join_pool_internal
   * 计算一致（合约用 lottery.join_paxi + lottery.join_tkcc），否则签名验证失败，
   * 且 PAXI 参与费会绕过会话日限额（HIGH-1）。
   */
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

  // ---------- B2 平台模板池：交易 ----------
  /**
   * 激活模板并参与（B2 主入口）。**不传金额**：参与费由合约从链上池子读取。
   * joinTkccRaw / joinPaxiRaw 只用于构造无感签名原文（必须等于池子的 join_tkcc / join_paxi），
   * 签名原文 roundId = templateId（池子可能本笔才创建，前端不知道 pool id）。
   * amount = PAXI + TKCC 的 raw 总和，必须与合约端 join_pool_internal 一致，
   * 否则签名验证失败，且 PAXI 参与费会绕过会话日限额（HIGH-1）。
   *
   * 触发者（该模板第一个激活的人）与其他参与者**完全一致**：无任何额外奖励。
   */
  function activateTemplate(templateId, joinTkccRaw, joinPaxiRaw) {
    const totalAmount = (BigInt(joinTkccRaw) + BigInt(joinPaxiRaw)).toString();
    return K.execute(
      { activate_template: { template_id: Number(templateId) } },
      [],
      {
        gas: 700000,
        session: {
          action: 'activate_template',
          roundId: String(templateId),
          amount: totalAmount,
        },
        memo: 'activate template',
      }
    );
  }

  /**
   * 管理员：创建模板。
   *
   * ⚠️ `PoolTemplate` 的两个参与费**单位不对称**（注意：与 `Lottery` 池子不同，池子两个都是 raw）：
   *   - `join_paxi` —— **raw**（upaxi 最小单位）  → 这里 `paxiToRaw()`
   *   - `join_tkcc` —— **个数**，合约内部再 ×10^decimals → 这里传**个数**，不要转 raw
   * 该约定与合约 `state.rs::PoolTemplate` 的字段注释一致；
   * 改动此处务必同步 `app.js::onActivate` 的读取换算，否则无感签名 amount 会算错。
   */
  function createPoolTemplate(name, joinPaxiHuman, joinTkccCount, minPeople, maxPeople) {
    return K.execute(
      {
        create_pool_template: {
          name,
          join_paxi: paxiToRaw(joinPaxiHuman),
          join_tkcc: String(joinTkccCount),
          min_people: Number(minPeople),
          max_people: Number(maxPeople),
        },
      },
      [],
      { gas: 600000, memo: 'create template' }
    );
  }

  const updatePoolTemplate = (id, active) =>
    K.execute({ update_pool_template: { id: Number(id), active: !!active } }, [], {
      gas: 400000,
      memo: 'update template',
    });

  const updatePoolTemplateParams = (id, opts) =>
    K.execute(
      {
        update_pool_template_params: {
          id: Number(id),
          name: opts && opts.name != null ? opts.name : null,
          join_paxi: opts && opts.joinPaxiHuman != null ? paxiToRaw(opts.joinPaxiHuman) : null,
          join_tkcc: opts && opts.joinTkccCount != null ? String(opts.joinTkccCount) : null,
          min_people: opts && opts.minPeople != null ? Number(opts.minPeople) : null,
          max_people: opts && opts.maxPeople != null ? Number(opts.maxPeople) : null,
        },
      },
      [],
      { gas: 500000, memo: 'update template params' }
    );

  const drawLottery = (id) =>
    K.execute({ draw_lottery: { id: Number(id) } }, [], { gas: 800000, memo: 'draw lottery' });

  const claim = (id) =>
    K.execute({ claim: { id: Number(id) } }, [], { gas: 500000, memo: 'claim prize' });

  const refund = (id) =>
    K.execute({ refund: { id: Number(id) } }, [], { gas: 500000, memo: 'refund' });

  /** commit-reveal：揭示建池时的 secret（sha256(secret) 必须等于 commit_hash） */
  const revealSecret = (id, secret) =>
    K.execute({ reveal_secret: { id: Number(id), secret } }, [], { gas: 400000, memo: 'reveal secret' });

  // ---------- 管理员：TKCC 集成 ----------
  /**
   * 设置本合约内的 TKCC 地址（发币后的一次性开关）。
   * 不传则用 config.js 里写死的地址。调用后所有 TKCC 功能自动启用，无需迁移。
   */
  function setTkccToken(token) {
    const t = token || C.tkccToken;
    if (!t) throw new Error('未提供 TKCC 合约地址');
    return K.execute({ admin: { set_tkcc_token: { token: t } } }, [], {
      gas: 300000,
      memo: 'set tkcc token',
    });
  }

  /** 设置 TKCC 销毁黑洞地址（抽奖 6% 销毁用；不配则开奖前会报 BurnAddressNotConfigured） */
  function setTkccBurnAddress(address) {
    if (!address) throw new Error('未提供销毁黑洞地址');
    return K.execute({ admin: { set_tkcc_burn_address: { address } } }, [], {
      gas: 300000,
      memo: 'set tkcc burn address',
    });
  }

  /** 设置销毁方式：'burn'（调 PRC-20 burn）| 'black_hole'（转黑洞，默认）| 'skip'（转金库，仅测试网） */
  function setTkccBurnMode(mode) {
    return K.execute({ admin: { set_tkcc_burn_mode: { mode } } }, [], {
      gas: 300000,
      memo: 'set tkcc burn mode',
    });
  }

  /** 管理员：设置运营金库（抽奖运营分成全部进这里）。不传则用 config.js 的 treasury */
  function setTreasury(treasury) {
    const t = treasury || C.treasury;
    if (!t) throw new Error('未提供运营金库地址');
    return K.execute({ admin: { set_treasury: { treasury: t } } }, [], {
      gas: 300000,
      memo: 'set treasury',
    });
  }

  // ---------- 展示辅助 ----------
  const statusText = {
    open: '报名中',
    full: '已满员',
    drawn: '已开奖',
    refunded: '已退款',
    cancelled: '已取消',
  };

  function fmtPaxi(raw) {
    return K.fmt(raw, C.coinDecimals);
  }
  function fmtTkcc(raw, decimals) {
    return K.fmt(raw, decimals == null ? C.tkccDecimals : decimals);
  }

  /** 把链上 Lottery 对象转成便于渲染的视图（含 UTC 过期时间） */
  function toView(l, tkccDecimals) {
    return {
      id: l.id,
      creator: l.creator,
      joinPaxi: fmtPaxi(l.join_paxi),
      joinPaxiRaw: l.join_paxi,
      joinTkcc: fmtTkcc(l.join_tkcc, tkccDecimals),
      joinTkccRaw: l.join_tkcc,
      minPeople: l.min_people,
      maxPeople: l.max_people,
      // M2：开奖后 pool_* 归零，历史奖池在 settled_pool_*；
      // 展示时优先用快照，避免"奖池显示 0"或"仍显示原值"的误导。
      poolPaxi: fmtPaxi(l.settled_pool_paxi && l.settled_pool_paxi !== '0' ? l.settled_pool_paxi : l.pool_paxi),
      poolTkcc: fmtTkcc((l.settled_pool_tkcc && l.settled_pool_tkcc !== '0' ? l.settled_pool_tkcc : l.pool_tkcc), tkccDecimals),
      count: l.participant_count,
      status: l.status,
      statusText: statusText[l.status] || l.status,
      expiresAt: Number(l.expires_at) * 1000,
      expiresText: new Date(Number(l.expires_at) * 1000).toLocaleString('zh-CN'),
      winners: l.winners,
      payout: l.payout,
      seed: l.seed,
      randomSource: l.random_source,
      needsReveal: !!l.commit_hash && !l.revealed,
      // 双模式标记
      isTemplatePool: !!l.is_template_pool,
      templateId: l.template_id == null ? null : l.template_id,
    };
  }

  window.CJLottery = {
    tkcc, tkccTokenInfo, config, contractConfig, resolveTkcc,
    lottery, lotteries, participants, winners, payout, balance, balances,
    poolTemplates, poolTemplate, activePoolOfTemplates,
    depositPaxi, depositTkcc, withdraw,
    createLottery, joinLottery, activateTemplate, drawLottery, claim, refund, revealSecret,
    createPoolTemplate, updatePoolTemplate, updatePoolTemplateParams,
    setTkccToken, setTkccBurnAddress, setTkccBurnMode, setTreasury,
    paxiToRaw, tkccToRaw, fmtPaxi, fmtTkcc, toView, statusText,
  };
})();
