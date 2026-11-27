// -----------------------------------------------------------------------------
// GitHub Actions secrets are sealed with the repository public key
// (libsodium crypto_box_seal), as documented by GitHub.
// -----------------------------------------------------------------------------

import sodium from 'libsodium-wrappers';

export async function sealSecret(publicKeyBase64, value) {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
