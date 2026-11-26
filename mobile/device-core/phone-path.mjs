// Only a computer lists its local workspaces. A phone has no filesystem API in the asset runtime.
function desktopOnly() { throw new Error('Local agent workspaces are available on the desktop.') }
export default { isAbsolute: desktopOnly, resolve: desktopOnly, basename: desktopOnly }
