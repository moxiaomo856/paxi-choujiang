/* =====================================================================
 * i18n.js —— 中英文语言包
 *
 * 用法：
 *   静态文本：HTML 上加 data-i18n="key"（占位符用 data-i18n-placeholder）
 *   动态文本：CJ_I18N.t('key', { name: value })
 *   切换语言：CJ_I18N.toggle() / setLang('en')
 * 语言存 localStorage，首次按浏览器语言自动判断。
 * ===================================================================== */
(function () {
  const KEY = 'cj_lang';
  const LANGS = ['zh', 'en'];

  const DICT = {
    zh: {
      /* ---- 通用 ---- */
      'common.refresh': '刷新',
      'common.share': '🔗 分享',
      'common.copyOk': '已复制{label} ✓',
      'common.copyFail': '复制失败，请长按手动选择',
      'common.processing': '处理中…',
      'common.libLoading': '交易库加载中，请稍候…',
      'common.libFail': '交易库加载失败，请检查网络后刷新页面',
      'common.busy': '上一笔交易还在处理中，请等它完成（可看下方日志）后再操作。',

      /* ---- 导航 ---- */
      'nav.tabPools': '奖池',
      'nav.tabCreate': '创建',
      'nav.tabMe': '我的',
      'nav.tabAdmin': '管理',

      /* ---- 顶栏 / 钱包 ---- */
      'wallet.notConnected': '未连接',
      'wallet.connect': '连接',
      'wallet.openSession': '开无感',
      'wallet.closeSession': '关无感',
      'wallet.sessionTag': '无感',

      /* ---- 奖池页 ---- */
      'pools.claimsTitle': '🎁 待领奖',
      'pools.filter.ongoing': '进行中',
      'pools.filter.all': '全部（含已结束）',
      'pools.filter.open': '报名中',
      'pools.filter.full': '已满员',
      'pools.filter.drawn': '已开奖',
      'pools.empty': '暂无奖池',
      'pools.leftDays': '剩余 {d} 天 {h} 小时',
      'pools.leftHours': '剩余 {h} 小时 {m} 分',
      'pools.leftMinutes': '剩余 {m} 分钟',
      'pools.expired': '已截止',
      'pools.fee': '参与费',
      'pools.pool': '奖池',
      'pools.people': '{c} / {m} 人',
      'pools.join': '参与',
      'pools.draw': '开奖',
      'pools.refund': '退款',
      'pools.tagMine': '我建的',
      'pools.tagJoined': '已参与',
      'pools.winFirst': '恭喜你，一等奖，待领奖',
      'pools.winSecond': '恭喜你，二等奖，待领奖',
      'pools.winFirstDone': '一等奖 · 已领取',
      'pools.winSecondDone': '二等奖 · 已领取',
      'pools.claimNow': '一键领奖',
      'pools.claiming': '领取中…',

      /* ---- 创建页 ---- */
      'create.chooseTier': '选择档位',
      'create.peopleFull': '{n} 人满员',
      'create.perJoin': '每人参与：',
      'create.fee': '建池费：',
      'create.feeNote': '（全额进奖池）',
      'create.btn': '建池并支付建池费',
      'create.btnShort': '内部余额不足，请先充值',
      'create.hint': '建池费全额进入奖池，满员自动开奖，任何人都可以触发开奖。',
      'create.costFee': '建池费（进奖池）',
      'create.costBal': '内部余额',
      'create.balShort': '内部余额不足：本池需要 {need}，你还差 {lack}。请先充值。',

      /* ---- 我的页 ---- */
      'me.balance': '内部余额',
      'me.balPaxi': 'PAXI',
      'me.balTkcc': 'TKCC',
      'me.balBank': '链上 PAXI',
      'me.depositWithdraw': '充值 / 提现',
      'me.amount': '数量',
      'me.deposit': '充值',
      'me.withdraw': '提现',
      'me.depositHint': '高频操作走内部余额 + 无感签名；提现会回到链上钱包地址。',
      'me.claims': '🎁 待领奖',
      'me.created': '🏗️ 我建的池',
      'me.joined': '🎯 我参与的池',
      'me.emptyClaims': '暂无待领奖',
      'me.emptyCreated': '你还没有建过池',
      'me.emptyJoined': '你还没有参与过',
      'me.needConnect': '请先连接钱包',

      /* ---- 无感引导卡片 ---- */
      'sessCard.titleEnable': '开启「无感」',
      'sessCard.descEnable': '开启后参与 / 建池不用弹钱包（24 小时有效）',
      'sessCard.titleConnect': '请先连接钱包',
      'sessCard.descConnect': '连接后才能参与抽奖',
      'sessCard.btnEnable': '立即开启',
      'sessCard.btnConnect': '连接',

      /* ---- 我的页：会话状态 ---- */
      'sessStatus.label': '无感会话',
      'sessStatus.off': '未开启',
      'sessStatus.on': '已开启（24 小时）',
      'sessStatus.offHint': '开启后参与 / 建池不用弹钱包（24 小时有效）',
      'sessStatus.connectHint': '连接钱包后可开启',
      'sessStatus.gas': '会话 gas：{v} PAXI（约 {n} 次操作）',
      'sessStatus.gasLow': '会话 gas 仅剩 {v} PAXI，建议「关闭」后重新开启补充',
      'sessStatus.gasMissing': '会话账户未初始化（gas 未到账）',
      'sessStatus.notConnected': '未连接',

      /* ---- 管理页 ---- */
      'admin.opsConfig': '运营配置',
      'admin.tkccIntegration': 'TKCC 集成',
      'admin.enableTkcc': '启用 TKCC（写入合约）',
      'admin.rewriteTkcc': '重新写入 TKCC 地址',
      'admin.burnMode': '销毁方式（开奖 6%）',
      'admin.burnBlackHole': 'BlackHole —— 转到黑洞地址（推荐）',
      'admin.burnBurn': 'Burn —— 调用 TKCC 的 burn',
      'admin.burnSkip': 'Skip —— 转入金库（仅测试网）',
      'admin.burnAddrPh': '黑洞地址（仅 BlackHole 需要）',
      'admin.applyBurnMode': '应用销毁方式',
      'admin.setBurn': '设置黑洞地址',

      /* ---- 日志 / 提示 ---- */
      'msg.connected': '已连接 {addr}',
      'msg.sessionExpired': '无感会话已失效，请重新开启',
      'msg.sessionClosed': '已关闭无感',
      'msg.sessionOpened': '无感已开启：{addr}',
      'msg.sessionOpenedBanner': '无感已开启（{h} 小时）：已给会话账户预存 {g} PAXI gas，之后参与 / 建池不再弹钱包。',
      'msg.joinOk': '参与 #{id} 成功',
      'msg.joinOkBanner': '参与成功 ✓',
      'msg.drawOk': '开奖 #{id} 成功',
      'msg.drawOkBanner': '开奖成功 ✓',
      'msg.claimOk': '领取 #{id} 成功',
      'msg.claimOkBanner': '🎉 领奖成功！已存入内部余额',
      'msg.refundOk': '已退款 ✓',
      'msg.refundLog': '退款 #{id} 成功',
      'msg.createOk': '创建成功',
      'msg.createOkBanner': '建池成功 ✓',
      'msg.depositOk': '充值 {a} {t} 成功',
      'msg.depositOkBanner': '充值成功 ✓',
      'msg.withdrawOk': '提现 {a} {t} 成功',
      'msg.withdrawOkBanner': '提现成功 ✓',
      'msg.tkccAutoStart': '合约尚未启用 TKCC，正在自动写入…（请在钱包里确认一次）',
      'msg.tkccAutoOk': '已自动启用 TKCC：{addr}',
      'msg.tkccAutoFail': '自动启用 TKCC 未成功，可在「管理」页手动点一次。',
      'msg.tkccEnabled': '已启用 TKCC ✓',
      'msg.cryptoLibFail': '加密库未加载：无感会话将不可用。请检查网络后刷新。',
      'msg.wechatTip': '微信无法直接唤起 PaxiHub，请点右上角「...」→「在浏览器打开」',
      'msg.deepLinking': '正在唤起 PaxiHub App…若未安装将跳转下载页。',
      'msg.inHubWait': 'PaxiHub 已检测到，但钱包桥接尚未就绪。请稍等片刻后下拉刷新，或从 PaxiHub 重新打开本页。',
      'msg.notInHub': '未检测到 PaxiHub 钱包（只有手机版）。请用手机在 PaxiHub App 内打开本页面。',
      'msg.shareLog': '已分享 #{id}',
      'msg.shareBanner': '📩 好友分享了奖池 #{id}，点下方「参与」加入。',
      'msg.shareBannerNoWallet': '📩 好友分享了奖池 #{id} 给你，先连接钱包再参与。',
      'msg.tkccNotConfigured': 'TKCC 未配置：创建 / 参与抽奖会返回 TkccNotConfigured。',
      'msg.tkccNotConfiguredAdmin': '本合约尚未启用 TKCC，点上方按钮写入。',
      'msg.poolNotFound': '奖池不存在',
      'msg.inputAmount': '请输入数量',
      'msg.burnAddrRequired': '请填写销毁黑洞地址',
      'msg.noTkccInConfig': 'config.js 里未配置 tkccToken',
      'msg.noTreasuryInConfig': 'config.js 里没有 treasury 地址',
      'msg.statusOnchain': '链上',
      'msg.statusFallback': 'config.js 兜底',
      'msg.adminsLine': '管理员（{src}，阈值 {t}）：{list}',
      'msg.treasuryLine': '运营金库（链上）：{v}',
      'msg.treasuryMismatch': ' · config.js 里是 {v}',
      'msg.paused': ' · ⚠️ 合约已暂停',
      'msg.treasurySame': '运营金库一致（可重写）',
      'msg.treasuryWrite': '写入运营金库',
      'msg.tkccStatusLine': 'TKCC 合约：{addr}（{symbol}，decimals {d}）· 已启用：{on}',
      'msg.tkccStatusEmpty': 'TKCC 合约：config.js 未配置',

      /* ---- 错误前缀 ---- */
      'err.action': '操作失败',
      'err.create': '创建失败',
      'err.deposit': '充值失败',
      'err.withdraw': '提现失败',
      'err.enableTkcc': '启用 TKCC 失败',
      'err.setTreasury': '写入运营金库失败',
      'err.setBurnMode': '设置销毁方式失败',
      'err.setBurn': '设置黑洞失败',

      /* ---- 合约状态 ---- */
      'status.open': '报名中',
      'status.full': '已满员',
      'status.drawn': '已开奖',
      'status.refunded': '已退款',
      'status.cancelled': '已取消',

      /* ---- 分享 / 共享链接 ---- */
      'share.title': 'Paxi 抽奖 #{id}',
      'share.body': '🎰 Paxi 抽奖 #{id}\n参与费 {jp} PAXI + {jt} TKCC\n奖池已累积 {pp} PAXI + {pt} TKCC\n一起参与吧！',

      /* ---- 通用：是 / 否 ---- */
      'common.yes': '是',
      'common.no': '否',

      /* ---- 管理页：写入反馈（log） ---- */
      'msg.tkccWritten': '已写入 TKCC 地址：{addr}',
      'msg.treasuryWritten': '已写入运营金库：{v}',
      'msg.burnModeSet': '已设置销毁方式：{m}',
      'msg.burnSet': '已设置销毁黑洞：{a}',
      'msg.treasuryConfigFallback': '运营金库（config.js，合约未就绪）：{v}',

      /* ---- lottery.js 内抛错 ---- */
      'err.invalidTier': '非法档位',
      'err.noTkccParam': '未提供 TKCC 合约地址',
      'err.noTreasuryParam': '未提供运营金库地址',
      'err.tkccNotConfiguredLottery': 'TKCC 未配置（合约尚未 SetTkccToken）',
      'common.tier': '档位',
    },

    en: {
      'common.refresh': 'Refresh',
      'common.share': '🔗 Share',
      'common.copyOk': 'Copied{label} ✓',
      'common.copyFail': 'Copy failed — long-press to select manually',
      'common.processing': 'Processing…',
      'common.libLoading': 'Loading transaction library, please wait…',
      'common.libFail': 'Transaction library failed to load. Check your network and refresh.',
      'common.busy': 'A transaction is still pending. Wait for it to finish (see the log below) before retrying.',

      'nav.tabPools': 'Pools',
      'nav.tabCreate': 'Create',
      'nav.tabMe': 'Me',
      'nav.tabAdmin': 'Admin',

      'wallet.notConnected': 'Not connected',
      'wallet.connect': 'Connect',
      'wallet.openSession': 'Seamless',
      'wallet.closeSession': 'Turn off',
      'wallet.sessionTag': 'Seamless',

      'pools.claimsTitle': '🎁 Unclaimed prizes',
      'pools.filter.ongoing': 'Active',
      'pools.filter.all': 'All (incl. ended)',
      'pools.filter.open': 'Open',
      'pools.filter.full': 'Full',
      'pools.filter.drawn': 'Drawn',
      'pools.empty': 'No pools yet',
      'pools.leftDays': '{d}d {h}h left',
      'pools.leftHours': '{h}h {m}m left',
      'pools.leftMinutes': '{m}m left',
      'pools.expired': 'Expired',
      'pools.fee': 'Entry fee',
      'pools.pool': 'Prize pool',
      'pools.people': '{c} / {m} joined',
      'pools.join': 'Join',
      'pools.draw': 'Draw',
      'pools.refund': 'Refund',
      'pools.tagMine': 'Created by me',
      'pools.tagJoined': 'Joined',
      'pools.winFirst': 'You won 1st prize — claim it now',
      'pools.winSecond': 'You won 2nd prize — claim it now',
      'pools.winFirstDone': '1st prize · claimed',
      'pools.winSecondDone': '2nd prize · claimed',
      'pools.claimNow': 'Claim prize',
      'pools.claiming': 'Claiming…',

      'create.chooseTier': 'Choose a tier',
      'create.peopleFull': '{n} players',
      'create.perJoin': 'Entry fee per player: ',
      'create.fee': 'Pool creation fee: ',
      'create.feeNote': ' (100% into the prize pool)',
      'create.btn': 'Create pool & pay fee',
      'create.btnShort': 'Insufficient internal balance — deposit first',
      'create.hint': 'The creation fee goes entirely into the prize pool. Drawing is automatic when full — anyone can trigger it.',
      'create.costFee': 'Creation fee (into pool)',
      'create.costBal': 'Internal balance',
      'create.balShort': 'Insufficient balance: this pool needs {need}; you still need {lack}. Please deposit first.',

      'me.balance': 'Internal balance',
      'me.balPaxi': 'PAXI',
      'me.balTkcc': 'TKCC',
      'me.balBank': 'On-chain PAXI',
      'me.depositWithdraw': 'Deposit / Withdraw',
      'me.amount': 'Amount',
      'me.deposit': 'Deposit',
      'me.withdraw': 'Withdraw',
      'me.depositHint': 'Frequent actions use the internal balance + seamless signing; withdrawing sends funds back to your wallet.',
      'me.claims': '🎁 Unclaimed prizes',
      'me.created': '🏗️ Pools I created',
      'me.joined': '🎯 Pools I joined',
      'me.emptyClaims': 'Nothing to claim',
      'me.emptyCreated': "You haven't created a pool yet",
      'me.emptyJoined': "You haven't joined any pool yet",
      'me.needConnect': 'Please connect your wallet first',

      'sessCard.titleEnable': 'Enable “Seamless”',
      'sessCard.descEnable': 'Join / create pools without wallet popups (valid 24h)',
      'sessCard.titleConnect': 'Connect your wallet first',
      'sessCard.descConnect': 'You need a wallet to join pools',
      'sessCard.btnEnable': 'Enable now',
      'sessCard.btnConnect': 'Connect',

      'sessStatus.label': 'Seamless session',
      'sessStatus.off': 'Disabled',
      'sessStatus.on': 'Enabled (24h)',
      'sessStatus.offHint': 'Join / create pools without wallet popups (valid 24h)',
      'sessStatus.connectHint': 'Connect your wallet to enable',
      'sessStatus.gas': 'Session gas: {v} PAXI (~{n} actions)',
      'sessStatus.gasLow': 'Session gas is low ({v} PAXI) — turn it off and on again to top up',
      'sessStatus.gasMissing': 'Session account not initialized (gas not received)',
      'sessStatus.notConnected': 'Not connected',

      'admin.opsConfig': 'Operations',
      'admin.tkccIntegration': 'TKCC integration',
      'admin.enableTkcc': 'Enable TKCC (write to contract)',
      'admin.rewriteTkcc': 'Rewrite TKCC address',
      'admin.burnMode': 'Burn method (6% on draw)',
      'admin.burnBlackHole': 'BlackHole — send to black-hole address (recommended)',
      'admin.burnBurn': 'Burn — call TKCC burn',
      'admin.burnSkip': 'Skip — send to treasury (testnet only)',
      'admin.burnAddrPh': 'Black-hole address (BlackHole only)',
      'admin.applyBurnMode': 'Apply burn method',
      'admin.setBurn': 'Set black-hole address',

      'msg.connected': 'Connected {addr}',
      'msg.sessionExpired': 'Seamless session expired — please enable again',
      'msg.sessionClosed': 'Seamless session disabled',
      'msg.sessionOpened': 'Seamless enabled: {addr}',
      'msg.sessionOpenedBanner': 'Seamless enabled ({h}h). {g} PAXI gas was prefunded to the session account — joining / creating pools no longer needs a wallet popup.',
      'msg.joinOk': 'Joined #{id}',
      'msg.joinOkBanner': 'Joined ✓',
      'msg.drawOk': 'Drawn #{id}',
      'msg.drawOkBanner': 'Draw complete ✓',
      'msg.claimOk': 'Claimed #{id}',
      'msg.claimOkBanner': '🎉 Claimed! Credited to your internal balance',
      'msg.refundOk': 'Refunded ✓',
      'msg.refundLog': 'Refunded #{id}',
      'msg.createOk': 'Pool created',
      'msg.createOkBanner': 'Pool created ✓',
      'msg.depositOk': 'Deposited {a} {t}',
      'msg.depositOkBanner': 'Deposit complete ✓',
      'msg.withdrawOk': 'Withdrew {a} {t}',
      'msg.withdrawOkBanner': 'Withdrawal complete ✓',
      'msg.tkccAutoStart': 'TKCC not enabled on the contract — writing it automatically… (confirm once in your wallet)',
      'msg.tkccAutoOk': 'TKCC enabled automatically: {addr}',
      'msg.tkccAutoFail': 'Auto-enabling TKCC failed — tap the button on the Admin page.',
      'msg.tkccEnabled': 'TKCC enabled ✓',
      'msg.cryptoLibFail': 'Crypto library not loaded: seamless signing unavailable. Check your network and refresh.',
      'msg.wechatTip': 'WeChat cannot open PaxiHub directly — tap “...” → “Open in Browser”',
      'msg.deepLinking': 'Opening PaxiHub App… You will be redirected to the download page if it is not installed.',
      'msg.inHubWait': 'PaxiHub detected but the wallet bridge is not ready yet. Wait a moment and pull to refresh, or reopen this page from PaxiHub.',
      'msg.notInHub': 'PaxiHub wallet not found (mobile only). Please open this page inside the PaxiHub App.',
      'msg.shareLog': 'Shared #{id}',
      'msg.shareBanner': '📩 A friend shared pool #{id} with you — tap “Join” below.',
      'msg.shareBannerNoWallet': '📩 A friend shared pool #{id} with you — connect your wallet to join.',
      'msg.tkccNotConfigured': 'TKCC not configured: creating / joining pools returns TkccNotConfigured.',
      'msg.tkccNotConfiguredAdmin': 'TKCC is not enabled on this contract — tap the button above.',
      'msg.poolNotFound': 'Pool not found',
      'msg.inputAmount': 'Enter an amount',
      'msg.burnAddrRequired': 'Enter the black-hole address',
      'msg.noTkccInConfig': 'tkccToken is not set in config.js',
      'msg.noTreasuryInConfig': 'treasury address is not set in config.js',
      'msg.statusOnchain': 'on-chain',
      'msg.statusFallback': 'config.js fallback',
      'msg.adminsLine': 'Admins ({src}, threshold {t}): {list}',
      'msg.treasuryLine': 'Treasury (on-chain): {v}',
      'msg.treasuryMismatch': ' · config.js has {v}',
      'msg.paused': ' · ⚠️ contract paused',
      'msg.treasurySame': 'Treasury matches (rewrite)',
      'msg.treasuryWrite': 'Write treasury',
      'msg.tkccStatusLine': 'TKCC contract: {addr} ({symbol}, decimals {d}) · enabled: {on}',
      'msg.tkccStatusEmpty': 'TKCC contract: not set in config.js',

      'err.action': 'Action failed',
      'err.create': 'Create failed',
      'err.deposit': 'Deposit failed',
      'err.withdraw': 'Withdraw failed',
      'err.enableTkcc': 'Failed to enable TKCC',
      'err.setTreasury': 'Failed to write treasury',
      'err.setBurnMode': 'Failed to set burn method',
      'err.setBurn': 'Failed to set black-hole address',

      'status.open': 'Open',
      'status.full': 'Full',
      'status.drawn': 'Drawn',
      'status.refunded': 'Refunded',
      'status.cancelled': 'Cancelled',

      'share.title': 'Paxi Lottery #{id}',
      'share.body': '🎰 Paxi Lottery #{id}\nEntry fee {jp} PAXI + {jt} TKCC\nPrize pool {pp} PAXI + {pt} TKCC\nJoin us!',

      'common.yes': 'Yes',
      'common.no': 'No',

      'msg.tkccWritten': 'Wrote TKCC address: {addr}',
      'msg.treasuryWritten': 'Wrote treasury: {v}',
      'msg.burnModeSet': 'Set burn method: {m}',
      'msg.burnSet': 'Set black-hole address: {a}',
      'msg.treasuryConfigFallback': 'Treasury (config.js fallback, contract not ready): {v}',

      'err.invalidTier': 'Invalid tier',
      'err.noTkccParam': 'TKCC contract address not provided',
      'err.noTreasuryParam': 'Treasury address not provided',
      'err.tkccNotConfiguredLottery': 'TKCC not configured (contract has not SetTkccToken)',
      'common.tier': 'Tier',
    },
  };

  let lang = loadLang();

  function loadLang() {
    try {
      const v = localStorage.getItem(KEY);
      if (LANGS.indexOf(v) >= 0) return v;
    } catch (_) {}
    const nav = (navigator.language || '').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function t(key, params) {
    let s = (DICT[lang] && DICT[lang][key]) || (DICT.zh && DICT.zh[key]);
    if (s == null) return key;
    if (params) {
      Object.keys(params).forEach((k) => {
        s = s.split('{' + k + '}').join(params[k]);
      });
    }
    return s;
  }

  /** 把静态 DOM 上的 data-i18n / data-i18n-placeholder 套用到当前语言 */
  function apply() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    const btn = document.getElementById('btnLang');
    if (btn) btn.textContent = lang === 'zh' ? 'EN' : '中文';
    window.dispatchEvent(new Event('lang-changed'));
  }

  function setLang(next) {
    if (LANGS.indexOf(next) < 0 || next === lang) return;
    lang = next;
    try { localStorage.setItem(KEY, next); } catch (_) {}
    apply();
  }

  const toggle = () => setLang(lang === 'zh' ? 'en' : 'zh');

  window.CJ_I18N = { t, apply, setLang, toggle, getLang: () => lang, LANGS };

  // 首屏：按当前语言套用静态 DOM（data-i18n）
  apply();
})();
