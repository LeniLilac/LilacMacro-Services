export interface ReleaseTrust {
  keyId: string;
  publicKeySpkiBase64: string;
}

export const officialReleaseTrust: ReleaseTrust = Object.freeze({
  keyId: 'release-2026-01',
  publicKeySpkiBase64: 'MCowBQYDK2VwAyEA/W36+Xl+KMvjLGYQTGysqL0a75mVoeTbTUoR+J/IqJY=',
});
