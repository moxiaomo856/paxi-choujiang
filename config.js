/* =====================================================================
 * config.js —— 抽奖前端配置
 * 与合约常量严格对应：改合约就要改这里。
 * ===================================================================== */
window.CJ_CONFIG = {
  // ---- 链 ----
  chainId: 'paxi-mainnet',
  rpc: 'https://mainnet-rpc.paxinet.io',
  lcd: 'https://mainnet-lcd.paxinet.io',
  bech32Prefix: 'paxi',
  coinDenom: 'PAXI',
  coinMinimalDenom: 'upaxi',
  coinDecimals: 6,          // 1 PAXI = 10^6 upaxi
  gasPrice: 0.05,           // upaxi / gas
  defaultGas: 600000,

  // ---- 签名域名（必须与合约 state.rs 的 SIGN_DOMAIN 一致）----
  signDomain: 'lottery',

  // ---- 合约（已部署主网地址，勿再改成占位符）----
  contract: 'paxi183js7jj7lceqpw6v2j9yagwet673gyeqvy9k5d58nwtjp0p9azpqsctvms',

  // TKCC 外部 PRC-20（已发币，写死）
  tkccToken: 'paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms',
  tkccDecimals: 6,

  // ---- 管理员 / 运营 ----
  admins: [
    'paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd',
    'paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j',
  ],
  multisigThreshold: 1,
  treasury: 'paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem',

  // ---- 三档规格（必须与合约 tier_spec 一致）----
  // joinPaxi/joinTkcc 每人参与费；createPaxi/createTkcc 建池费（TKCC 为个数）
  tiers: [
    { id: 0, label: '5 人档',  people: 5,  joinPaxi: 1,  joinTkcc: 10000,  createPaxi: 1,  createTkcc: 20000 },
    { id: 1, label: '20 人档', people: 20, joinPaxi: 2,  joinTkcc: 20000,  createPaxi: 15, createTkcc: 100000 },
    { id: 2, label: '50 人档', people: 50, joinPaxi: 10, joinTkcc: 100000, createPaxi: 60, createTkcc: 600000 },
  ],
  defaultTier: 0,

  // 官方模板池：彻底隐藏（合约仍支持，前端不展示）
  showTemplatePools: false,

  // ---- 无感会话 ----
  sessionDailyLimit: '1000000000000',
  // 开启无感时随注册一笔转入会话账户的 gas（upaxi），耗尽后自动回退钱包签名
  sessionGasFund: '300000',
  keepSeamless: true,
  sessionTtlHours: 24,

  // 列表轮询（毫秒）；切到后台自动暂停
  pollInterval: 10000,

  // 管理员连接后，若合约尚未写入 TKCC 地址则自动发起启用（仍需钱包确认一次）
  autoEnableTkcc: true,
};
