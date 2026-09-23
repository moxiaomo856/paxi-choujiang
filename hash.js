/* =====================================================================
 * hash.js —— 加密工具（不自己实现密码学原语，全部走 CDN 库）
 * 依赖 index.html 引入：
 *   @noble/secp256k1 → window.nobleSecp256k1
 *   @noble/hashes    → window.nobleHashes（sha256 / ripemd160）
 *   bech32           → window.bech32
 * ===================================================================== */
(function () {
  function requireLib() {
    const pk = window.nobleSecp256k1 || (window.noble && window.noble.secp256k1);
    const hs = window.nobleHashes || (window.noble && window.noble.hashes);
    const bc = window.bech32 || (window.bech32Lib && window.bech32Lib.bech32);
    if (!pk) throw new Error('缺少 @noble/secp256k1（CDN 未加载）');
    if (!hs || !hs.ripemd160) throw new Error('缺少 @noble/hashes 的 ripemd160（CDN 未加载）');
    if (!bc) throw new Error('缺少 bech32（CDN 未加载）');
    return { pk, hs, bc };
  }

  const hexOf = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const bytesOf = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((x) => parseInt(x, 16)));

  /** secp256k1 压缩公钥 → paxi 地址（sha256 → ripemd160 → bech32） */
  function pubkeyToAddr(pubHex, prefix) {
    const { hs, bc } = requireLib();
    const sha = hs.sha256(bytesOf(pubHex));
    const rip = hs.ripemd160(sha);
    return bc.encode(prefix, bc.toWords(rip));
  }

  /** 生成会话密钥对（压缩公钥 33 字节） */
  function genKeyPair() {
    const { pk } = requireLib();
    const priv = pk.utils.randomPrivateKey
      ? pk.utils.randomPrivateKey()
      : globalThis.crypto.getRandomValues(new Uint8Array(32));
    return { privHex: hexOf(priv), pubHex: hexOf(pk.getPublicKey(priv, true)) };
  }

  /** 裸 SHA-256 后签名，返回 64 字节 hex（r‖s，canonical low-S） */
  function signHash(message, privHex) {
    const { pk, hs } = requireLib();
    const sha = hs.sha256(new TextEncoder().encode(message));
    const sig = pk.sign(sha, bytesOf(privHex));
    let sigBytes;
    if (sig instanceof Uint8Array) sigBytes = sig;
    else if (sig && sig.r && sig.s) {
      sigBytes = new Uint8Array(64);
      sigBytes.set(sig.r, 0);
      sigBytes.set(sig.s, 32);
    } else {
      throw new Error('签名结果格式未知');
    }
    return hexOf(sigBytes);
  }

  function sha256Hex(str) {
    const { hs } = requireLib();
    return hexOf(hs.sha256(new TextEncoder().encode(str)));
  }

  function ready() {
    try {
      requireLib();
      return true;
    } catch (e) {
      return false;
    }
  }

  window.CJHash = { pubkeyToAddr, genKeyPair, signHash, sha256Hex, ready, hexOf, bytesOf };
})();
