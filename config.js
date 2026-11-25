// Runtime config. The website leaves this empty: it talks to /api on the same
// host and asks for the passkey. The Windows and Android builds overwrite this
// file with the API address and their built-in app key, so they open straight
// into the chats without a passkey.
window.MIDO_CONFIG = window.MIDO_CONFIG || {};
