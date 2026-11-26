declare const __TOGLE_RELEASE_CHANNEL__: 'beta' | 'stable'

export const betaBuild = typeof __TOGLE_RELEASE_CHANNEL__ !== 'undefined' && __TOGLE_RELEASE_CHANNEL__ === 'beta'
export const betaRelay = 'wss://relay.togle.app/v1'
export const betaProfile = 'togle-beta'
