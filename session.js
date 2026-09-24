/* =====================================================================
 * session.js —— 无感会话密钥（抽奖专用，domain = "lottery"）
 *
 * 主钱包一次性 RegisterSession 绑定会话公钥 → 之后用会话私钥本地签名，
 * 合约验签后以「主钱包」身份执行，免去逐笔弹钱包。
 *
 * 签名原文（必须与合约 paxi-common::session::build_sign_bytes 逐字一致）：
 *   "{chainId}:{contract}:{domain}:{action}:{roundId}:{amount}:{nonce}:{pubkeyHex}"
 * 哈希：裸 SHA-256（非 ADR-36），签名 hex 解码后 64/65 字节。
 *
 * 【安全说明】会话私钥存 localStorage。
 *   手机端 sessionStorage 在切后台 / 锁屏时会被系统清空，导致无感会话失效；
 *   而 sessionStorage 与 localStorage 在 XSS / 同域脚本 / 浏览器扩展面前等价，
 *   唯一差异在"设备被物理接触且浏览器未锁" —— 该场景下攻击者本就能直接打开
 *   钱包 App 转走资产，无需偷会话私钥。故采用 localStorage 并明确声明安全边界。
 *
 *   缓解措施：
 *   - 会话私钥 ≠ 主钱包私钥，泄漏仅影响 daily_limit 额度内资金；
 *   - 链上可随时 RevokeSession（前端"关闭无感"按钮即触发）；
 *   - 主钱包私钥从不落地。
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;

  // 手机端（Paxi 钱包 App / WKWebView / Android WebView）会在切后台、锁屏、
  // 内存紧张时清空 sessionStorage，导致无感会话刚开就失效，用户被迫反复弹钱包。
  // 因此改用 localStorage 持久化。安全边界见 README"无感签名"章节。
  const STORE = window.localStorage;
  const LS = { priv: 'cj_sess_priv', pub: 'cj_sess_pub', addr: 'cj_sess_addr', nonce: 'cj_sess_nonce', user: 'cj_sess_user' };

  const state = {
    sessPriv: '',
    sessPubHex: '',
    sessAddr: '',
    sessNonce: 0,
    sessUser: '',
    enabled: false,
  };

  // 按主钱包地址隔离存储（换号不串会话）
  const sk = (base) => base + '__' + (K.wallet.address || 'anon');

  /** 升级清理：清掉旧格式 key（没有 __<addr> 后缀的遗留数据）
   *  模块加载时 K.wallet.address 为空，sk(b) 会得到 b__anon，从没被写过（persist 要 address）。
   *  真正需要清的是 localStorage 里直接以 LS 值为 key 的遗留条目。
   *  L-3：一次性标记统一放 META JSON 对象（避免散落 __cj_xxx / __cj_yyy 多键），
   *       META.key 带应用前缀，将来可扩展更多 flag。*/
  const META_KEY = '__cj_session_meta';
  function getMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
  }
  function setMeta(key, val) {
    const m = getMeta(); m[key] = val;
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {}
  }
  function _wipeLegacyLocalStorage() {
    if (getMeta().legacy_wiped) return;
    try {
      const prefixes = Object.values(LS);
      for (const k of Object.keys(localStorage)) {
        if (prefixes.includes(k)) localStorage.removeItem(k);
      }
      setMeta('legacy_wiped', Date.now());
    } catch (_) { /* 某些环境禁用 localStorage 也别炸 */ }
  }

  function persist() {
    if (!K.wallet.address) return;
    STORE.setItem(sk(LS.priv), state.sessPriv);
    STORE.setItem(sk(LS.pub), state.sessPubHex);
    STORE.setItem(sk(LS.addr), state.sessAddr);
    STORE.setItem(sk(LS.nonce), String(state.sessNonce));
    STORE.setItem(sk(LS.user), state.sessUser);
  }

  function restore() {
    if (!K.wallet.address) return false;
    state.sessPriv = STORE.getItem(sk(LS.priv)) || '';
    state.sessPubHex = STORE.getItem(sk(LS.pub)) || '';
    state.sessAddr = STORE.getItem(sk(LS.addr)) || '';
    state.sessNonce = Number(STORE.getItem(sk(LS.nonce)) || 0);
    state.sessUser = STORE.getItem(sk(LS.user)) || '';
    state.enabled = !!(state.sessPriv && state.sessAddr && state.sessUser === K.wallet.address);
    return state.enabled;
  }

  function clear() {
    Object.values(LS).forEach((b) => STORE.removeItem(sk(b)));
    _wipeLegacyLocalStorage();
    state.sessPriv = state.sessPubHex = state.sessAddr = state.sessUser = '';
    state.sessNonce = 0;
    state.enabled = false;
  }

  // 模块加载即清一次 legacy
  _wipeLegacyLocalStorage();

  /** 开启无感（唯一一次弹钱包） */
  async function enable() {
    if (!K.wallet.address) await K.connect();
    if (!window.CJHash || !(await window.CJHash.ready())) {
      throw new Error('加密库未就绪（secp256k1 / hashes / bech32 CDN 未加载）');
    }

    // 注册新会话前先撤销本地遗留的旧会话：
    // enable() 每次都生成新密钥对，不清旧的话旧 session 会一直占着链上
    // RegisterSession 的每主钱包会话上限（MAX_SESSIONS_PER_USER）。
    // 旧会话已过期 / 已被撤销时报错无所谓，clear() 会把本地状态清掉。
    if (state.sessAddr && state.sessUser === K.wallet.address) {
      try {
        await K.execute(
          { revoke_session: { session_addr: state.sessAddr } },
          [],
          { gas: 300000, memo: 'revoke old session' }
        );
      } catch (_) { /* 旧会话已过期/已撤销都无所谓 */ }
      clear();
    }

    const { privHex, pubHex } = window.CJHash.genKeyPair();
    const sessAddr = window.CJHash.pubkeyToAddr(pubHex, C.bech32Prefix);

    const msg = {
      register_session: {
        session_addr: sessAddr,
        pubkey: pubHex,
        daily_limit: String(C.sessionDailyLimit || '1000000000000'),
      },
    };
    const res = await K.execute(msg, [], { gas: 400000, memo: 'register session' });
    if (res.code !== 0) throw new Error(res.rawLog || '注册会话失败');

    state.sessPriv = privHex;
    state.sessPubHex = pubHex;
    state.sessAddr = sessAddr;
    state.sessUser = K.wallet.address;
    state.sessNonce = 0;
    state.enabled = true;
    persist();
    return sessAddr;
  }

  /** 从链上同步 nonce（以链上为准，避免本地计数漂移） */
  async function syncNonce() {
    if (!state.sessAddr) return 0;
    try {
      const res = await K.queryContract({ session: { session_addr: state.sessAddr } });
      if (res && res.info) {
        state.sessNonce = Number(res.info.nonce || 0);
        persist();
      } else {
        // 会话不存在（被撤销 / 过期）→ 清掉本地存储并关闭无感。
        // 只置 enabled = false 不够：storage 里还留着 session，下次连接
        // restore() 会把它恢复出来，每次连接都对死会话空试一轮。
        clear();
      }
    } catch (e) {
      /* 查询失败时沿用本地 nonce */
    }
    return state.sessNonce;
  }

  /**
   * 签名原文（第一段 chainId 必须**与交易签名同源**）。
   *
   * P3-1：原先这里用 config.js 的硬编码 `C.chainId`，而 chain.js 取链上值。
   * 两者目前都是 `paxi-mainnet` 所以看不出问题；一旦链改名或换链，交易能正常
   * 发出、会话验签却会全量失败，且很难定位。统一走 `K.getChainId()`。
   */
  async function buildMessage(action, roundId, amount, nonce) {
    return [
      await K.getChainId(),
      C.contract,
      C.signDomain,
      action,
      String(roundId === undefined || roundId === null ? '0' : roundId),
      String(amount === undefined || amount === null ? '0' : amount),
      String(nonce),
      state.sessPubHex,
    ].join(':');
  }

  /**
   * 给 ExecuteMsg 注入 auth 字段。
   * @param {object} execMsg 原始消息，如 { join_lottery: { id: 1 } }
   * @param {string} action  合约校验用的 action 名
   * @param {string} roundId 业务轮次（抽奖 ID / "0"）
   * @param {string} amount  本次扣费金额（raw，进签名原文）
   */
  async function signPayload(execMsg, action, roundId, amount) {
    if (!state.enabled) throw new Error('未开启无感会话');
    const nonce = state.sessNonce;
    const message = await buildMessage(action, roundId, amount, nonce);
    const signature = await window.CJHash.signHash(message, state.sessPriv);

    const key = Object.keys(execMsg)[0];
    const payload = {
      ...execMsg,
      [key]: { ...execMsg[key], auth: { session_addr: state.sessAddr, nonce, signature } },
    };

    // 本地先自增；交易失败时调用 rollbackNonce()
    state.sessNonce = nonce + 1;
    persist();
    return { payload, nonce, signature, message };
  }

  /** 交易失败后回滚 nonce */
  function rollbackNonce() {
    state.sessNonce = Math.max(0, state.sessNonce - 1);
    persist();
  }

  window.CJSession = { state, enable, clear, restore, persist, syncNonce, signPayload, rollbackNonce, buildMessage };
})();
