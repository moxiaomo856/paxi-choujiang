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
    // hook 用 UTF-8 字节再 base64：toBase64(String) 走的是文本路径，
    // 对含多字节字符的 JSON 才严格等价；统一走字节路径避免编码歧义
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

  /**
   * 建池（simple 版，走无感签名）：只选档位，费用由前端 tiers 表算出。
   * amount 进签名原文 = 该档建池费 PAXI + TKCC 的 raw 总和，
   * 必须与合约端 tier_spec 一致，否则签名验证失败。
   */
  async function createLottery(opts) {
    const { tier, commitHash } = opts;
    const t = C.tiers.find((x) => x.id === Number(tier));
    if (!t) throw new Error('非法档位');
    const tkccInfo = await resolveTkcc();
    const feeTkccRaw = tkccToRaw(t.createTkcc, tkccInfo.decimals);
    const feePaxiRaw = paxiToRaw(t.createPaxi);
    const totalAmount = (BigInt(feeTkccRaw) + BigInt(feePaxiRaw)).toString();
    return K.execute(
      {
        create_lottery: {
          tier: Number(tier),
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
   * 管理员：创建模板（simple 版：只选档位）。
   *
   * 同时自动生成一条随机哈希链（默认 64 个值）：
   *   sN 随机 64-hex，s_i = sha256(s_{i+1})；提交给合约的承诺 = sha256(s1)。
   * 整条链（不含已提交的承诺）存 localStorage：cj_tpl_chain_<template_id>。
   * 每次开奖前用 revealTemplateSecret() 揭示一个；换设备 / 清缓存会**永久丢失**，
   * 届时该模板的池子只能退款，务必备份。
   */
  async function createPoolTemplate(name, tier, chainLen = 64) {
    if (!(window.CJHash && (await window.CJHash.ready()))) {
      throw new Error('加密库未加载，无法生成秘密链；请检查网络后重试');
    }
    const { commit, chain } = genSecretChain(chainLen);
    const res = await K.execute(
      {
        create_pool_template: {
          name,
          tier: Number(tier),
          commit_hash: commit,
        },
      },
      [],
      { gas: 600000, memo: 'create template' }
    );
    // 从事件里拿 template_id 存链
    const tid = res.attributes?.find((a) => a.key === 'template_id')?.value;
    if (tid) {
      try {
        localStorage.setItem('cj_tpl_chain_' + tid, JSON.stringify(chain));
      } catch (e) { /* 忽略存储失败，banner 会提示手动备份 */ }
    }
    return { res, tid, chainLen: chain.length };
  }

  /**
   * 管理员：揭示模板的下一个秘密（从本机链里取队首）。返回揭示值。
   *
   * 前置校验（软门禁）：
   * * 无活跃池 → 直接拦截（揭示纯属浪费一个 secret）。
   * * 活跃池未满员 → **软警告**，err.needForce = true；管理员再点一次
   *   （force = true）即可强制揭示。
   *
   * ⚠️ 为什么"未满员"不能硬拦：满员池的指针会被下一个 ActivateTemplate
   * 覆盖（P1 满员 → 用户 F 激活 → 指针切到 P2，count=1/5）。此时之前的
   * 满员池 P1 仍在等揭示，合约端完全放行（只对 Open 且过期禁止），若前端
   * 硬拦，P1 就卡到过期退款。所以未满员只提示、不阻止，由管理员判断。
   * 两个满员池即使共用同一 secret 开奖，candidate set 与 pool_id 都不同，
   * 结果彼此独立，无安全风险。
   */
  async function revealTemplateSecret(templateId, force = false) {
    const tid = Number(templateId);
    const active = await activePoolOfTemplates().catch(() => ({ entries: [] }));
    const entry = (active.entries || []).find((e) => e.template_id === tid);
    // ⚠️ entry 缺失有两种可能：模板真的没有活跃池，或模板被停用
    //（active_pool_of_templates 会跳过 inactive 模板，但合约揭示并不要求
    // 模板 active）。后者下可能有满员池在等揭示 —— 所以降级为软警告，
    // 管理员确认后可强制。
    if (!entry || entry.active_pool_id == null) {
      if (!force) {
        const err = new Error(
          '未查到该模板的活跃池（可能没有活跃池，或模板已停用）。若确有满员池在等待揭示，请再点一次确认强制执行。'
        );
        err.needForce = true;
        throw err;
      }
    } else if (entry.participant_count < entry.max_people && !force) {
      const err = new Error(
        '当前活跃池尚未满员（' + entry.participant_count + '/' + entry.max_people
        + '）。若这是之前的满员池在等待揭示（活跃池指针已被新池覆盖），请再点一次"揭示"确认强制执行。'
      );
      err.needForce = true;
      throw err;
    }
    const key = 'cj_tpl_chain_' + tid;
    let chain;
    try { chain = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { chain = null; }
    if (!Array.isArray(chain) || !chain.length) {
      throw new Error('本机没有模板 #' + tid + ' 的秘密链（换设备 / 清缓存会丢失）。若已丢失，该模板的池子只能退款。');
    }
    const secret = chain.shift();
    await K.execute(
      { admin_custom: { reveal_template_secret: { template_id: tid, secret } } },
      [],
      { gas: 400000, memo: 'reveal template secret' }
    );
    try { localStorage.setItem(key, JSON.stringify(chain)); } catch (e) { /* 忽略 */ }
    return secret;
  }

  /** 生成随机哈希链：sN 随机，s_i = sha256(s_{i+1})；commit = sha256(s1) */
  function genSecretChain(len) {
    const chain = [];
    let cur = randomHex64();
    for (let i = 0; i < len; i++) {
      chain.unshift(cur);
      cur = window.CJHash.sha256Hex(cur);
    }
    const commit = window.CJHash.sha256Hex(chain[0]);
    return { commit, chain };
  }

  function randomHex64() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  const updatePoolTemplate = (id, active) =>
    K.execute({ update_pool_template: { id: Number(id), active: !!active } }, [], {
      gas: 400000,
      memo: 'update template',
    });

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
    const tier = C.tiers.find((t) => t.id === Number(l.tier));
    return {
      id: l.id,
      creator: l.creator,
      tier: l.tier,
      tierLabel: tier ? tier.label : '档位' + l.tier,
      joinPaxi: fmtPaxi(l.join_paxi),
      joinPaxiRaw: l.join_paxi,
      joinTkcc: fmtTkcc(l.join_tkcc, tkccDecimals),
      joinTkccRaw: l.join_tkcc,
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
      // needsReveal 只描述**玩家池**（A 模式）：建池者承诺了但还没揭示。
      // 模板池的 revealed 恒为 None（揭示值存 TEMPLATE_SECRETS 查表、不回写池子），
      // 不能用这两个字段判断 —— 否则官方池永远显示"未揭示"，误导管理员。
      needsReveal: !!l.commit_hash && !l.revealed && !l.is_template_pool,
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
    createPoolTemplate, revealTemplateSecret, genSecretChain, updatePoolTemplate,
    setTkccToken, setTkccBurnAddress, setTkccBurnMode, setTreasury,
    paxiToRaw, tkccToRaw, fmtPaxi, fmtTkcc, toView, statusText,
  };
})();
