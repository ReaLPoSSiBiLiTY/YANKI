'use strict'
// Ed25519 kimlik — Node'un yerleşik kripto modülü. Aynı tohumdan (seed)
// Hyperswarm için libsodium biçiminde anahtar çifti de üretilir; böylece
// ağ bağlantısının karşı tarafı kriptografik olarak doğrulanmış olur.
const crypto = require('crypto')

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const pubCache = new Map()

function fromSeed (seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
  return {
    privateKey,
    publicKey: Buffer.from(publicRaw),
    // libsodium/Hyperswarm biçimi: secretKey = seed || publicKey
    swarmKeyPair: { publicKey: Buffer.from(publicRaw), secretKey: Buffer.concat([seed, publicRaw]) }
  }
}

function publicKeyObject (hex) {
  let k = pubCache.get(hex)
  if (!k) {
    k = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' })
    if (pubCache.size > 5000) pubCache.clear()
    pubCache.set(hex, k)
  }
  return k
}

function sign (privateKey, data) {
  return crypto.sign(null, data, privateKey).toString('base64')
}

function verify (authorHex, data, sigB64) {
  try {
    return crypto.verify(null, data, publicKeyObject(authorHex), Buffer.from(sigB64, 'base64'))
  } catch {
    return false
  }
}

module.exports = { fromSeed, sign, verify }
