/* =====================================================================
 * chain.js —— 钱包连接 + 链上查询 / 交易
 *
 * 钱包适配层（统一抽象两种接口）：
 *   1. window.paxihub   ← PaxiHub App（手机端主用，官方推荐）
 *      API: hub.paxi.getAddress() → { address, public_key }
 *           hub.paxi.signAndSendTransaction({ bodyBytes, authInfoBytes, chainId, accountNumber })
 *   2. window.keplr     ← Keplr / 桌面钱包（兼容）
 *      API: keplr.enable(chainId)
 *           keplr.signAndBroadcast(chainId, addr, msgs, fee, memo)
 *
 * 优先级：检测到 paxihub → 用 paxihub（sign + broadcast 一步完成）
 *         否则检测 keplr → 用 keplr
 *         两者都没有 → hasWallet() 返回 false，触发 UI 兜底
 *
 * DApp 指南参考：仓库根目录《DApp 指南.txt》§2 / §3.4
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchWithTimeout(url, opt = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opt, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const toBase64 = (bytes) => {
    // bytes 可以是字符串（兼容旧代码）或 Uint8Array
    if (typeof bytes === 'string') {
      return btoa(unescape(encodeURIComponent(bytes)));
    }
    // Uint8Array → base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  /** raw → 人类可读 */
  function fmt(raw, dec) {
    if (raw === null || raw === undefined || raw === '') return '0';
    const n = Number(raw) / Math.pow(10, dec);
    return n.toLocaleString('zh-CN', { maximumFractionDigits: dec });
  }

  /** 人类可读 → raw（字符串拼接，避免浮点误差） */
  function toRaw(human, dec) {
    const s = String(human).trim();
    if (!s) return '0';
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [int, frac = ''] = body.split('.');
    const f = (frac + '0'.repeat(dec)).slice(0, dec);
    const v = (BigInt(int || '0') * BigInt(Math.pow(10, dec)) + BigInt(f || '0')).toString();
    return neg ? '-' + v : v;
  }

  // ---------- 钱包 ----------
  const wallet = { address: '', pubkeyHex: '', kind: '' }; // kind: 'paxihub' | 'keplr' | ''

  /** 检测钱包类型：优先 paxihub（手机端），回退 keplr（桌面/兼容） */
  function detectWalletKind() {
    if (typeof window.paxihub !== 'undefined' && window.paxihub.paxi) return 'paxihub';
    if (typeof window.keplr !== 'undefined') return 'keplr';
    return '';
  }

  const hasWallet = () => detectWalletKind() !== '';

  async function connect() {
    const kind = detectWalletKind();
    if (!kind) throw new Error('未检测到 Paxi 钱包。请在 PaxiHub App 内置浏览器打开，或安装 Keplr 桌面钱包。');

    if (kind === 'paxihub') {
      // §3.2 getAddress
      const info = await window.paxihub.paxi.getAddress();
      wallet.address = info.address;
      // info.public_key 是字节数组 → hex
      wallet.pubkeyHex = Array.from(info.public_key || [])
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      wallet.kind = 'paxihub';
    } else {
      // keplr 路径
      await window.keplr.enable(C.chainId);
      const signer = window.getOfflineSigner(C.chainId);
      const accs = await signer.getAccounts();
      if (!accs.length) throw new Error('钱包没有可用账户');
      wallet.address = accs[0].address;
      wallet.pubkeyHex = Array.from(accs[0].pubkey || [])
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      wallet.kind = 'keplr';
    }
    return wallet.address;
  }

  // ---------- 查询 ----------
  /** 查询合约（默认查抽奖合约；传 contract 可查别的合约，如 TKCC） */
  async function queryContract(msg, contract) {
    const addr = contract || C.contract;
    if (!addr || addr.startsWith('PASTE_')) throw new Error('合约地址未配置（config.js）');
    const url = `${C.lcd}/cosmwasm/wasm/v1/contract/${addr}/smart/${toBase64(JSON.stringify(msg))}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`查询失败 ${res.status}`);
    const json = await res.json();
    if (json.code) throw new Error(json.message || '查询返回错误');
    return json.data;
  }

  async function getBankBalances(address) {
    const res = await fetchWithTimeout(`${C.lcd}/cosmos/bank/v1beta1/balances/${address}`);
    const json = await res.json();
    return json.balances || [];
  }

  // ---------- paxihub 专属辅助 ----------
  /** §3.2 fetch accountNumber & sequence */
  async function buildCommon(chainId, address) {
    const res = await fetchWithTimeout(`${C.lcd}/cosmos/auth/v1beta1/accounts/${address}`);
    const json = await res.json();
    const account = json.account || {};
    const ba = account.base_account || account;
    return {
      accountNumber: Number(ba.account_number || '0'),
      sequence: Number(ba.sequence || '0'),
    };
  }

  /** 把 CosmJS Any 格式的 msgs 转成 TxBody.messages 需要的 proto Any */
  function toProtoAny(typeUrl, msgValueObj) {
    return {
      typeUrl,
      value: PaxiCosmJS.Encoder.toBase64(
        PaxiCosmJS.MsgExecuteContract.encode({
          sender: msgValueObj.sender,
          contract: msgValueObj.contract,
          msg: msgValueObj.msg,
          funds: msgValueObj.funds || [],
        }).finish()
      ),
    };
  }

  // ---------- 交易 ----------
  async function waitForTx(hash, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetchWithTimeout(`${C.lcd}/cosmos/tx/v1beta1/txs/${hash}`, {}, 10000);
        if (res.ok) {
          const txr = (await res.json()).tx_response || {};
          if (txr.code === 0) return { ok: true, raw: txr };
          if (txr.code) return { ok: false, raw: txr, log: txr.raw_log };
        }
      } catch (e) {
        /* 瞬时错误，继续轮询 */
      }
      await sleep(1500);
    }
    throw new Error('交易确认超时（链上可能已成功，请刷新查看）');
  }

  /**
   * 用 paxihub 发交易（§3.4 buildAndSendTx 的精简版）。
   * 只走 wasm ExecuteContract，其余类型暂不需要。
   */
  async function executeViaPaxihub(execMsg, funds, opts) {
    // 先等钱包库加载完
    if (typeof PaxiCosmJS === 'undefined') {
      throw new Error('PaxiCosmJS 库未加载，请检查网络');
    }

    const { accountNumber, sequence } = await buildCommon(C.chainId, wallet.address);

    // TxBody：msgs + memo
    const msgs = [
      PaxiCosmJS.Any.fromPartial({
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: PaxiCosmJS.MsgExecuteContract.encode({
          sender: wallet.address,
          contract: opts.contract || C.contract,
          msg: new TextEncoder().encode(JSON.stringify(execMsg)),
          funds: funds || [],
        }).finish(),
      }),
    ];
    const txBody = PaxiCosmJS.TxBody.fromPartial({
      messages: msgs,
      memo: opts.memo || '',
    });

    // Fee
    const gas = String(opts.gas || C.defaultGas);
    const feeAmount = [{ denom: C.coinMinimalDenom, amount: String(Math.max(1, Math.ceil(Number(gas) * C.gasPrice))) }];
    const fee = { amount: feeAmount, gasLimit: gas };

    // PubKey Any（sender.public_key）
    const pubkeyBytes = new Uint8Array(wallet.pubkeyHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    const pubkeyAny = {
      typeUrl: '/cosmos.crypto.secp256k1.PubKey',
      value: PaxiCosmJS.PubKey.encode({ key: pubkeyBytes }).finish(),
    };

    // AuthInfo
    const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
      signerInfos: [{
        publicKey: pubkeyAny,
        modeInfo: { single: { mode: 1 } },
        sequence: BigInt(sequence),
      }],
      fee,
    });

    // SignDoc（bodyBytes + authInfoBytes + chainId + accountNumber）
    const signDoc = PaxiCosmJS.SignDoc.fromPartial({
      bodyBytes: PaxiCosmJS.TxBody.encode(txBody).finish(),
      authInfoBytes: PaxiCosmJS.AuthInfo.encode(authInfo).finish(),
      chainId: C.chainId,
      accountNumber: BigInt(accountNumber),
    });

    // §3.4 signAndSendTransaction（钱包内部完成签名 + 广播）
    const txObj = {
      bodyBytes: PaxiCosmJS.Encoder.toBase64(signDoc.bodyBytes),
      authInfoBytes: PaxiCosmJS.Encoder.toBase64(signDoc.authInfoBytes),
      chainId: C.chainId,
      accountNumber: String(signDoc.accountNumber),
    };
    const result = await window.paxihub.paxi.signAndSendTransaction(txObj);

    // paxihub 返回值里通常有 code / transactionHash；有些版本只返回 success
    if (result && result.transactionHash) {
      return { code: 0, transactionHash: result.transactionHash };
    }
    if (result && typeof result.success !== 'undefined') {
      // 钱包内部已广播但没直接给 txHash，等一轮确认
      return { code: 0, transactionHash: '', raw: result };
    }
    if (result && result.code !== undefined && result.code !== 0) {
      throw new Error(result.rawLog || result.message || '交易失败（paxihub）');
    }
    return { code: 0, raw: result };
  }

  /**
   * 发送执行交易（统一入口，内部按钱包类型分发）。
   * @param {object} execMsg ExecuteMsg，如 { join_lottery: { id: 1, auth } }
   * @param {Array}  funds   原生币 [{ denom, amount }]
   * @param {object} opts    { gas, memo, contract, session:{action,roundId,amount} }
   */
  async function execute(execMsg, funds = [], opts = {}) {
    if (!wallet.address) await connect();

    // H4：标记本次是否用到了会话签名，用于失败时回滚 nonce
    const usedSession = opts.session && window.CJSession && window.CJSession.state.enabled;

    // 无感：注入会话签名（session_addr / nonce / signature）
    let finalMsg = execMsg;
    if (usedSession) {
      const { payload } = await window.CJSession.signPayload(
        execMsg,
        opts.session.action,
        opts.session.roundId,
        opts.session.amount
      );
      finalMsg = payload;
    }

    let res;
    try {
      if (wallet.kind === 'paxihub') {
        res = await executeViaPaxihub(finalMsg, funds, opts);
      } else {
        // keplr 路径（保持原有逻辑）
        if (!window.keplr || typeof window.keplr.signAndBroadcast !== 'function') {
          throw new Error('当前钱包不支持 signAndBroadcast');
        }
        const msgs = [
          {
            typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
            value: {
              sender: wallet.address,
              contract: opts.contract || C.contract,
              msg: new TextEncoder().encode(JSON.stringify(finalMsg)),
              funds: funds || [],
            },
          },
        ];
        const gas = String(opts.gas || C.defaultGas);
        const fee = {
          amount: [{ denom: C.coinMinimalDenom, amount: String(Math.max(1, Math.ceil(Number(gas) * C.gasPrice))) }],
          gas,
        };
        res = await window.keplr.signAndBroadcast(C.chainId, wallet.address, msgs, fee, opts.memo || '');
      }
    } catch (e) {
      // H4 修复：网络/钱包弹窗等异常 → 回滚本地 nonce
      if (usedSession) window.CJSession.rollbackNonce();
      throw e;
    }

    // paxihub 版本可能不返回 code，但会在上面抛异常；这里兜底
    if (res && res.code !== undefined && res.code !== 0) {
      if (usedSession) window.CJSession.rollbackNonce();
      throw new Error(res.rawLog || res.raw_log || res.message || '交易失败');
    }
    return res;
  }

  window.CJChain = {
    C,
    wallet,
    hasWallet,
    connect,
    queryContract,
    getBankBalances,
    execute,
    waitForTx,
    fmt,
    toRaw,
    toBase64,
    fetchWithTimeout,
  };
})();
