// -----------------------------------------------------------------------------
// Minimal CBOR decoder (RFC 8949), enough for WebAuthn: attestation objects
// and COSE public keys. Integers, byte/text strings, arrays, maps, simple
// values. No floats, no indefinite lengths (WebAuthn never uses them).
// -----------------------------------------------------------------------------

export class CborError extends Error {}

/** Decodes the first CBOR item of `buf`. Returns { value, length }. */
export function decodeFirst(buf, depthLimit = 16) {
  let pos = 0;

  const need = (n) => {
    if (pos + n > buf.length) throw new CborError('CBOR tronqué');
  };

  const readLength = (info) => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[pos++];
    }
    if (info === 25) {
      need(2);
      const v = buf.readUInt16BE(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = buf.readUInt32BE(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = buf.readBigUInt64BE(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('Entier CBOR trop grand');
      return Number(v);
    }
    throw new CborError('Longueur CBOR non prise en charge');
  };

  const item = (depth) => {
    if (depth > depthLimit) throw new CborError('CBOR trop imbriqué');
    need(1);
    const initial = buf[pos++];
    const major = initial >> 5;
    const info = initial & 31;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const len = readLength(info);
        need(len);
        const out = Buffer.from(buf.subarray(pos, pos + len));
        pos += len;
        return out;
      }
      case 3: {
        const len = readLength(info);
        need(len);
        const out = buf.toString('utf8', pos, pos + len);
        pos += len;
        return out;
      }
      case 4: {
        const len = readLength(info);
        if (len > 1000) throw new CborError('Tableau CBOR trop long');
        return Array.from({ length: len }, () => item(depth + 1));
      }
      case 5: {
        const len = readLength(info);
        if (len > 1000) throw new CborError('Objet CBOR trop long');
        const map = new Map();
        for (let i = 0; i < len; i += 1) {
          const key = item(depth + 1);
          map.set(key, item(depth + 1));
        }
        return map;
      }
      case 6:
        readLength(info); // tag: ignored, the tagged value is returned
        return item(depth + 1);
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new CborError('Valeur CBOR non prise en charge');
      default:
        throw new CborError('CBOR invalide');
    }
  };

  const value = item(0);
  return { value, length: pos };
}

export function decode(buf) {
  const { value, length } = decodeFirst(buf);
  if (length !== buf.length) throw new CborError('Données en trop après le CBOR');
  return value;
}
