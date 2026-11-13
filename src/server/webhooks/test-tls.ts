// A throwaway self-signed certificate for bot.example.com (valid 100 years), used only by send.test.ts.
// The private key protects nothing: it exists so a local TLS server can stand where a receiver would.
export const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU2gAwIBAgIUToOqS4MI8UpV5NI4iJKx3osK0wIwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPYm90LmV4YW1wbGUuY29tMCAXDTI2MTExMjEzNTI0MVoYDzIx
MjYxMDE5MTM1MjQxWjAaMRgwFgYDVQQDDA9ib3QuZXhhbXBsZS5jb20wWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATNNLx2Y03RFzI2yV8XyX6LpTEXM9kb4tIsFVIB
zcFTEqF4GmSYbk2EI+Rz5maTYaviRjpr8rc1RI5F1wIpmlz1o28wbTAdBgNVHQ4E
FgQUAR/NuUBEc4+eBN3Lfl7szcGCvsAwHwYDVR0jBBgwFoAUAR/NuUBEc4+eBN3L
fl7szcGCvsAwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgg9ib3QuZXhhbXBs
ZS5jb20wCgYIKoZIzj0EAwIDSAAwRQIgWCi8fCPzAMOINltstaRU7BHeeLsm/t9/
XrB7emCULIQCIQD3gSvxe79G/EMdHvN0FCsISFnoV7jZv+ze8r9dLVvdGw==
-----END CERTIFICATE-----`;

export const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1eqjgSErjZoPuExm
ZMme1NtczJzbzFriHuFSoCK38lGhRANCAATNNLx2Y03RFzI2yV8XyX6LpTEXM9kb
4tIsFVIBzcFTEqF4GmSYbk2EI+Rz5maTYaviRjpr8rc1RI5F1wIpmlz1
-----END PRIVATE KEY-----`;
