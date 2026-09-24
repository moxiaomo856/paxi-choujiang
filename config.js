/* =====================================================================
 * config.js —— 抽奖前端配置
 * 部署合约后把 contract / tkccToken 填进来即可，其余保持默认。
 * 与合约常量严格对应，改合约就要改这里。
 * ===================================================================== */
window.CJ_CONFIG = {
  // ---- 链 ----
  chainId: 'paxi-mainnet',
  rpc: 'https://mainnet-rpc.paxinet.io',
  lcd: 'https://mainnet-lcd.paxinet.io',
  bech32Prefix: 'paxi',
  coinDenom: 'PAXI',
  coinMinimalDenom: 'upaxi',
  coinDecimals: 6, // 1 PAXI = 10^6 upaxi（精度 6）
  gasPrice: 0.05, // upaxi / gas
  defaultGas: 600000,

  // ---- 签名域名（必须与合约 state.rs 的 SIGN_DOMAIN 一致）----
  signDomain: 'lottery',

  // ---- 合约（已部署：paxi-lottery-contract-simple 主网地址）----
  contract: 'paxi183js7jj7lceqpw6v2j9yagwet673gyeqvy9k5d58nwtjp0p9azpqsctvms',
  // TKCC 外部 PRC-20 合约地址（已发币，直接写死在这里）。
  // 运行时优先用合约 {"tkcc":{}} 的返回值；合约尚未 SetTkccToken 时用这里的地址兜底。
  tkccToken: 'paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms',
  // PAXI 与 TKCC 精度都是 6（1 个 = 10^6 raw）。
  // 运行时仍以 TKCC 合约 token_info 的 decimals 为准，这里只是查不到时的兜底。
  tkccDecimals: 6,

  // ---- 管理员 / 运营（部署时写入合约；前端用于兜底显示与一键写入）----
  // 管理员白名单（多签）。前端优先用链上 {"admins":{}}；查询失败时用这里兜底。
  admins: [
    'paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd',
    'paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j',
  ],
  // 多签阈值：1 = 任一管理员可直接执行；2 = 需两位管理员提案 + 确认
  multisigThreshold: 1,
  // 运营金库：抽奖运营分成（A 池 14%/15%，模板池 28%/30%）全部进这里
  treasury: 'paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem',

  // ---- 三档规格（必须与合约 state.rs::tier_spec 严格一致，改合约就要改这里）----
  // tier: 0=5 人档 / 1=20 人档 / 2=50 人档
  // joinPaxi/joinTkcc 为每人参与费；createPaxi/createTkcc 为建池费（TKCC 均为个数）
  tiers: [
    { id: 0, label: '5 人档', people: 5, joinPaxi: 1, joinTkcc: 10000, createPaxi: 1, createTkcc: 20000 },
    { id: 1, label: '20 人档', people: 20, joinPaxi: 2, joinTkcc: 20000, createPaxi: 15, createTkcc: 100000 },
    { id: 2, label: '50 人档', people: 50, joinPaxi: 10, joinTkcc: 100000, createPaxi: 60, createTkcc: 600000 },
  ],
  defaultTier: 0,
  // ⚠️ 仅 UI 文案：simple 版合约的抽奖时长由链上 LotteryConfig::default()（24h）
  // 决定，前端没有任何消息能改它。改这里不会影响链上行为。
  durationHours: 24,
  // B2 模式（官方模板池）：是否展示"官方奖池"区块
  showTemplatePools: true,

  // ---- 无感会话 ----
  // 会话单日限额（raw）。合约硬顶默认 1e12，这里取一个够用又不失控的值。
  sessionDailyLimit: '1000000000000',
  keepSeamless: true,
  sessionTtlHours: 24,
  // 开启无感时预存给会话账户的 gas（upaxi）。0.3 PAXI 按每次参与 ~3 万
  // upaxi 算约够 10 次操作；耗尽后参与会自动回退钱包签名路径，
  // 重新「开启无感」即可再充。
  sessionGasFund: '300000',

  // 列表自动轮询间隔（毫秒）。0 或省略则关闭轮询（仅切回页面可见时刷新）。
  // ⚠️ 之前这里漏配，而 app.js 用 `if (C.pollInterval > 0)` 判断，
  // undefined > 0 === false → 抽奖列表永远不自动刷新。与社交端保持一致。
  pollInterval: 8000,
};
